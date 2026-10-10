import { PermissionFlagsBits, type GuildMember, type Message } from "discord.js";
import { eq } from "drizzle-orm";
import { db, botSocialRoleGateTable } from "@workspace/db";
import { logger } from "../lib/logger";

const CONFIG_CACHE_MS = 15_000;
const roleCache = new Map<string, { expiresAt: number; roleIds: string[] | null }>();
const NO_MENTIONS = { parse: [] as never[], repliedUser: false };

function parseStoredRoleIds(value: string | undefined): string[] | null | undefined {
  if (value === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) {
      const roleIds = parsed.filter((id): id is string =>
        typeof id === "string" && /^\d{17,20}$/.test(id),
      );
      return roleIds.length > 0 ? roleIds : undefined;
    }
  } catch {}
  if (/^\d{17,20}$/.test(value)) return [value];
  return undefined;
}

async function getRequiredRoleIds(guildId: string): Promise<string[] | null | undefined> {
  const cached = roleCache.get(guildId);
  if (cached && cached.expiresAt > Date.now()) return cached.roleIds;

  try {
    const [config] = await db
      .select({ roleIds: botSocialRoleGateTable.requiredRoleId })
      .from(botSocialRoleGateTable)
      .where(eq(botSocialRoleGateTable.guildId, guildId))
      .limit(1);
    const roleIds = parseStoredRoleIds(config?.roleIds);
    if (roleIds === undefined) {
      logger.error({ guildId }, "Invalid social role configuration");
      return undefined;
    }
    roleCache.set(guildId, { expiresAt: Date.now() + CONFIG_CACHE_MS, roleIds });
    return roleIds;
  } catch (err) {
    logger.error({ err, guildId }, "Failed to load social role requirement");
    return undefined;
  }
}

export async function canUseSocialCommandsForMember(
  guildId: string,
  member: GuildMember,
): Promise<boolean | undefined> {
  const requiredRoleIds = await getRequiredRoleIds(guildId);
  if (requiredRoleIds === undefined) return undefined;
  return !requiredRoleIds || requiredRoleIds.some((roleId) => member.roles.cache.has(roleId));
}

export async function canUseSocialCommands(message: Message): Promise<boolean> {
  const guild = message.guild;
  if (!guild) return false;

  const requiredRoleIds = await getRequiredRoleIds(guild.id);
  if (requiredRoleIds === undefined) {
    await message.reply({
      content: "❌ I couldn't verify the social-command role requirement. Please try again shortly.",
      allowedMentions: NO_MENTIONS,
    });
    return false;
  }
  if (!requiredRoleIds) return true;

  const member = message.member ?? await guild.members.fetch(message.author.id).catch(() => null);
  if (member && requiredRoleIds.some((roleId) => member.roles.cache.has(roleId))) return true;

  await message.reply({
    content: `❌ You need one of these roles to use social commands: ${requiredRoleIds.map((roleId) => `<@&${roleId}>`).join(" or ")}.`,
    allowedMentions: NO_MENTIONS,
  });
  return false;
}

function parseRoleId(value: string): string | null {
  return /^<@&(\d{17,20})>$/.exec(value)?.[1] ?? (/^\d{17,20}$/.test(value) ? value : null);
}

export async function handleSocialRoleCommand(message: Message, args: string[]): Promise<void> {
  const guild = message.guild;
  if (!guild) return;

  const reply = (content: string) => message.reply({ content, allowedMentions: NO_MENTIONS });
  const member = message.member ?? await guild.members.fetch(message.author.id).catch(() => null);
  if (!member?.permissions.has(PermissionFlagsBits.ManageGuild) && !member?.permissions.has(PermissionFlagsBits.Administrator)) {
    await reply("❌ You need **Manage Server** permission to configure social commands.");
    return;
  }

  const subcommand = args[0]?.toLowerCase() ?? "status";
  try {
    if (subcommand === "set") {
      const roleIds = [...new Set([
        ...message.mentions.roles.keys(),
        ...args.slice(1)
          .map((value) => parseRoleId(value.replace(/,$/, "")))
          .filter((roleId): roleId is string => roleId !== null),
      ])];
      if (roleIds.length === 0 || roleIds.length > 10) {
        await reply("❌ Mention 1–10 valid server roles. Usage: `!socialrole set @role1 @role2`.");
        return;
      }
      const roles = await Promise.all(roleIds.map((roleId) => guild.roles.fetch(roleId).catch(() => null)));
      if (roles.some((role) => !role || role.id === guild.id)) {
        await reply("❌ All entries must be valid server roles. Usage: `!socialrole set @role1 @role2`.");
        return;
      }

      await db
        .insert(botSocialRoleGateTable)
        .values({ guildId: guild.id, requiredRoleId: JSON.stringify(roleIds) })
        .onConflictDoUpdate({
          target: botSocialRoleGateTable.guildId,
          set: { requiredRoleId: JSON.stringify(roleIds), updatedAt: new Date() },
        });
      roleCache.set(guild.id, { expiresAt: Date.now() + CONFIG_CACHE_MS, roleIds });
      await reply(`✅ Social commands now require any one of these roles: ${roles.join(", ")}.`);
      return;
    }

    if (subcommand === "remove" || subcommand === "clear" || subcommand === "off") {
      await db.delete(botSocialRoleGateTable).where(eq(botSocialRoleGateTable.guildId, guild.id));
      roleCache.set(guild.id, { expiresAt: Date.now() + CONFIG_CACHE_MS, roleIds: null });
      await reply("✅ The social-command role requirement has been removed.");
      return;
    }

    if (subcommand === "status") {
      const roleIds = await getRequiredRoleIds(guild.id);
      if (roleIds === undefined) {
        await reply("❌ Could not read the social-command role setting. Please try again shortly.");
        return;
      }
      await reply(roleIds
        ? `🔒 Social commands require any one of these roles: ${roleIds.map((roleId) => `<@&${roleId}>`).join(", ")}. Use ` + "`!socialrole set @role1 @role2`" + " to change them or " + "`!socialrole remove`" + " to disable the requirement."
        : "🔓 Social commands are available to everyone. Use `!socialrole set @role1 @role2` to require roles.");
      return;
    }

    await reply("Usage: `!socialrole set @role1 @role2`, `!socialrole status`, or `!socialrole remove`.");
  } catch (err) {
    logger.error({ err, guildId: guild.id, subcommand }, "Failed to configure social role requirement");
    await reply("❌ Could not update the social-command role setting. Please try again.").catch(() => {});
  }
}
