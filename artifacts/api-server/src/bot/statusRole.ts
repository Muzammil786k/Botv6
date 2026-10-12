import {
  ActivityType,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  type GuildMember,
  type Message,
  type Presence,
} from "discord.js";
import { eq } from "drizzle-orm";
import { botStatusRolesTable, db } from "@workspace/db";
import { logger } from "../lib/logger";

const DEFAULT_EMBED_TITLE = "<a:pp_hrt:1125452738893975672>　┈　thank you!　꒱";
const DEFAULT_EMBED_DESCRIPTION =
  "<:lounge_white_dot:1482412396273205400> {{user}} is now a {{role}} !\n" +
  "<:a_hrt:1262564222416453724> add {{trigger}} to your profile . . ♡";

async function reply(message: Message, content: string): Promise<void> {
  await message.reply({
    content,
    allowedMentions: { parse: [], repliedUser: false },
  });
}

export async function handleStatusRoleCommand(message: Message): Promise<void> {
  const guild = message.guild;
  if (!guild) return;

  const member = message.member ?? await guild.members.fetch(message.author.id).catch(() => null);
  if (!member?.permissions.has(PermissionFlagsBits.ManageGuild)) {
    await reply(message, "You need Manage Server permission to configure status roles.");
    return;
  }

  const action = message.content.trim().split(/\s+/, 2)[1]?.toLowerCase() ?? "status";
  try {
    if (action === "set") {
      const role = message.mentions.roles.first();
      const channel = message.mentions.channels.first();
      if (!role || !channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
        await reply(message, "Usage: `!statusrole set @role #logs <status trigger>`");
        return;
      }

      const botMember = await guild.members.fetchMe().catch(() => null);
      const channelPermissions = botMember ? channel.permissionsFor(botMember) : null;
      if (
        role.id === guild.id || role.managed ||
        !botMember?.permissions.has(PermissionFlagsBits.ManageRoles) ||
        botMember.roles.highest.comparePositionTo(role) <= 0
      ) {
        await reply(message, "I need Manage Roles permission, and my highest role must be above the selected role.");
        return;
      }
      if (!channelPermissions?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
      ])) {
        await reply(message, `I need View Channel, Send Messages, and Embed Links in ${channel}.`);
        return;
      }

      const triggerRaw = message.content.trim()
        .replace(/^!statusrole\s+set\s+/i, "")
        .replace(`<@&${role.id}>`, "")
        .replace(`<#${channel.id}>`, "")
        .trim();
      const triggerTexts = triggerRaw.split("|").map((value) => {
        const quotedTrigger = /^(?:"([\s\S]*)"|'([\s\S]*)')$/.exec(value.trim());
        return (quotedTrigger?.[1] ?? quotedTrigger?.[2] ?? value).trim();
      });
      if (triggerTexts.length > 10 || triggerTexts.some((trigger) => !trigger || trigger.length > 160)) {
        await reply(message, "Provide 1–10 status triggers, each between 1 and 160 characters, separated by `|`.");
        return;
      }

      await db.insert(botStatusRolesTable)
        .values({ guildId: guild.id, roleId: role.id, logChannelId: channel.id, triggerTexts })
        .onConflictDoUpdate({
          target: botStatusRolesTable.guildId,
          set: {
            roleId: role.id,
            logChannelId: channel.id,
            triggerTexts,
            updatedAt: new Date(),
          },
        });
      await reply(message, `Status role ${role} is set for triggers "${triggerTexts.join('", "')}"; logs will go to ${channel}.`);
      return;
    }

    if (action === "message") {
      const [settings] = await db.select()
        .from(botStatusRolesTable)
        .where(eq(botStatusRolesTable.guildId, guild.id))
        .limit(1);
      if (!settings) {
        await reply(message, "Set up the status role first with `!statusrole set @role #logs <trigger>`. ");
        return;
      }

      const value = message.content.trim().replace(/^!statusrole\s+message\s*/i, "");
      if (value.toLowerCase() === "reset") {
        await db.update(botStatusRolesTable)
          .set({ embedTitle: null, embedDescription: null, updatedAt: new Date() })
          .where(eq(botStatusRolesTable.guildId, guild.id));
        await reply(message, "Status-role embed message reset to the default.");
        return;
      }

      const separator = value.indexOf("|");
      const title = separator < 0 ? "" : value.slice(0, separator).trim();
      const description = separator < 0 ? "" : value.slice(separator + 1).trim();
      if (!title || !description || title.length > 256 || description.length > 4096) {
        await reply(message, "Usage: `!statusrole message <title> | <description>` (placeholders: `{{user}}`, `{{role}}`, `{{trigger}}`).");
        return;
      }

      await db.update(botStatusRolesTable)
        .set({ embedTitle: title, embedDescription: description, updatedAt: new Date() })
        .where(eq(botStatusRolesTable.guildId, guild.id));
      await reply(message, "Status-role log embed message updated.");
      return;
    }

    if (action === "remove" || action === "disable") {
      await db.delete(botStatusRolesTable).where(eq(botStatusRolesTable.guildId, guild.id));
      await reply(message, "Status-role automation has been disabled.");
      return;
    }

    if (action === "status") {
      const [settings] = await db.select()
        .from(botStatusRolesTable)
        .where(eq(botStatusRolesTable.guildId, guild.id))
        .limit(1);
      await reply(message, settings
        ? `Status role: <@&${settings.roleId}>\nTriggers: ${settings.triggerTexts.join(", ")}\nLogs: <#${settings.logChannelId}>\nSet the embed with !statusrole message <title> | <description>, or reset with !statusrole message reset.`
        : "Status-role automation is not configured. Use `!statusrole set @role #logs <status trigger>`.");
      return;
    }

    await reply(message, "Usage: `!statusrole set @role #logs <trigger>`, `!statusrole message <title> | <description>`, `!statusrole status`, or `!statusrole remove`.");
  } catch (error) {
    logger.error({ err: error, guildId: guild.id }, "Status-role command failed");
    await reply(message, "Could not update status-role settings. Please try again.").catch(() => {});
  }
}

function getMatchingTrigger(presence: Presence, triggerTexts: string[]): string | null {
  const customStatus = presence.activities
    .filter((activity) => activity.type === ActivityType.Custom)
    .map((activity) => activity.state ?? "")
    .join(" ")
    .toLocaleLowerCase();
  return triggerTexts.find((trigger) => customStatus.includes(trigger.toLocaleLowerCase())) ?? null;
}

async function syncStatusRole(
  guild: GuildMember["guild"],
  member: GuildMember,
  settings: typeof botStatusRolesTable.$inferSelect,
  qualification: string | null,
): Promise<void> {
  const role = await guild.roles.fetch(settings.roleId).catch(() => null);
  if (!role) return;
  const alreadyHasRole = member.roles.cache.has(role.id);

  if (!qualification) {
    if (alreadyHasRole) {
      await member.roles.remove(role, "Status trigger was removed");
    }
    return;
  }
  if (alreadyHasRole) return;

  await member.roles.add(role, "Status trigger became active");
  const channel = await guild.channels.fetch(settings.logChannelId).catch(() => null);
  if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) return;

  const title = settings.embedTitle ?? DEFAULT_EMBED_TITLE;
  const description = (settings.embedDescription ?? DEFAULT_EMBED_DESCRIPTION)
    .replaceAll("{{user}}", `<@${member.id}>`)
    .replaceAll("{{role}}", `<@&${role.id}>`)
    .replaceAll("{{trigger}}", qualification)
    .slice(0, 4096);
  await channel.send({
    embeds: [new EmbedBuilder().setColor(0xED83AE).setTitle(title).setDescription(description)],
    allowedMentions: { parse: [] },
  });
}

export async function handleStatusRolePresenceUpdate(
  oldPresence: Presence | null,
  presence: Presence,
): Promise<void> {
  if (presence.user.bot || presence.status === "offline") return;
  const guild = presence.guild;
  const [settings] = await db.select()
    .from(botStatusRolesTable)
    .where(eq(botStatusRolesTable.guildId, guild.id))
    .limit(1);
  if (!settings) return;

  const member = presence.member ?? await guild.members.fetch(presence.userId).catch(() => null);
  if (!member) return;
  const previousTrigger = oldPresence && oldPresence.status !== "offline"
    ? getMatchingTrigger(oldPresence, settings.triggerTexts)
    : null;
  const matchingTrigger = getMatchingTrigger(presence, settings.triggerTexts);
  if (oldPresence?.status !== "offline" && Boolean(previousTrigger) === Boolean(matchingTrigger)) return;
  await syncStatusRole(guild, member, settings, matchingTrigger);
}