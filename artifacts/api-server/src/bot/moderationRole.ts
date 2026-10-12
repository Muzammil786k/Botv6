import { PermissionFlagsBits, type Message } from "discord.js";
import { eq } from "drizzle-orm";
import { botModerationRoleGateTable, db } from "@workspace/db";
import { logger } from "../lib/logger";

const CONFIG_CACHE_MS = 15_000;
const roleCache = new Map<string, { expiresAt: number; roleId: string | null }>();
const NO_MENTIONS = { parse: [] as never[], repliedUser: false };

async function getRequiredRoleId(guildId: string): Promise<string | null | undefined> {
  const cached = roleCache.get(guildId);
  if (cached && cached.expiresAt > Date.now()) return cached.roleId;

  try {
    const [config] = await db
      .select({ roleId: botModerationRoleGateTable.requiredRoleId })
      .from(botModerationRoleGateTable)
      .where(eq(botModerationRoleGateTable.guildId, guildId))
      .limit(1);
    const roleId = config?.roleId ?? null;
    roleCache.set(guildId, { expiresAt: Date.now() + CONFIG_CACHE_MS, roleId });
    return roleId;
  } catch (err) {
    logger.error({ err, guildId }, "Failed to load moderation role requirement");
    return undefined;
  }
}

export async function canUseModerationCommands(message: Message): Promise<boolean> {
  const guild = message.guild;
  if (!guild) return false;

  const requiredRoleId = await getRequiredRoleId(guild.id);
  if (requiredRoleId === undefined) {
    await message.reply({
      content: "❌ I couldn't verify the moderation role requirement. Please try again shortly.",
      allowedMentions: NO_MENTIONS,
    });
    return false;
  }
  if (!requiredRoleId) {
    await message.reply({
      content: "❌ The moderation role isn't configured. A server admin can set it with `!modrole set @role`.",
      allowedMentions: NO_MENTIONS,
    });
    return false;
  }

  const member = message.member ?? await guild.members.fetch(message.author.id).catch(() => null);
  if (member?.roles.cache.has(requiredRoleId)) return true;

  await message.reply({
    content: `❌ You need the <@&${requiredRoleId}> role to use these moderation commands.`,
    allowedMentions: NO_MENTIONS,
  });
  return false;
}

function parseRoleId(value: string | undefined): string | null {
  if (!value) return null;
  return /^<@&?(\d{17,20})>$/.exec(value)?.[1] ?? (/^\d{17,20}$/.test(value) ? value : null);
}

export async function handleModerationRoleCommand(message: Message, args: string[]): Promise<void> {
  const guild = message.guild;
  if (!guild) return;

  const reply = (content: string) => message.reply({ content, allowedMentions: NO_MENTIONS });
  const member = message.member ?? await guild.members.fetch(message.author.id).catch(() => null);
  if (!member?.permissions.has(PermissionFlagsBits.ManageGuild) && !member?.permissions.has(PermissionFlagsBits.Administrator)) {
    await reply("❌ You need **Manage Server** permission to configure the moderation role.");
    return;
  }

  const action = args[0]?.toLowerCase() ?? "status";
  try {
    if (action === "set") {
      const roleId = message.mentions.roles.first()?.id ?? parseRoleId(args[1]);
      const role = roleId ? await guild.roles.fetch(roleId).catch(() => null) : null;
      if (!role || role.id === guild.id) {
        await reply("Usage: `!modrole set @role`.");
        return;
      }

      await db
        .insert(botModerationRoleGateTable)
        .values({ guildId: guild.id, requiredRoleId: role.id })
        .onConflictDoUpdate({
          target: botModerationRoleGateTable.guildId,
          set: { requiredRoleId: role.id, updatedAt: new Date() },
        });
      roleCache.set(guild.id, { expiresAt: Date.now() + CONFIG_CACHE_MS, roleId: role.id });
      await reply(`✅ Only members with ${role} can use ` + "`!warn`, `!clearwarnings`, `!mute`, and `!unmute`.");
      return;
    }

    if (action === "remove" || action === "clear" || action === "off") {
      await db.delete(botModerationRoleGateTable)
        .where(eq(botModerationRoleGateTable.guildId, guild.id));
      roleCache.set(guild.id, { expiresAt: Date.now() + CONFIG_CACHE_MS, roleId: null });
      await reply("✅ The moderation role requirement has been removed. The four commands remain blocked until a role is configured again.");
      return;
    }

    if (action === "status") {
      const roleId = await getRequiredRoleId(guild.id);
      if (roleId === undefined) {
        await reply("❌ Could not read the moderation role setting. Please try again shortly.");
      } else if (roleId) {
        await reply(`🔒 <@&${roleId}> is required for ` + "`!warn`, `!clearwarnings`, `!mute`, and `!unmute`.");
      } else {
        await reply("🔒 No moderation role is set; those commands are blocked. Configure one with `!modrole set @role`.");
      }
      return;
    }

    await reply("Usage: `!modrole set @role`, `!modrole status`, or `!modrole remove`.");
  } catch (err) {
    logger.error({ err, guildId: guild.id, action }, "Failed to configure moderation role requirement");
    await reply("❌ Could not update the moderation role setting. Please try again.").catch(() => {});
  }
}