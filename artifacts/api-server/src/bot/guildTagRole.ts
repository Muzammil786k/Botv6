import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  type Client,
  type Message,
  type PartialUser,
  type User,
} from "discord.js";
import { eq } from "drizzle-orm";
import { botGuildTagRolesTable, db } from "@workspace/db";
import { logger } from "../lib/logger";

async function reply(message: Message, content: string): Promise<void> {
  await message.reply({ content, allowedMentions: { parse: [], repliedUser: false } });
}

export async function handleGuildTagRoleCommand(message: Message): Promise<void> {
  const guild = message.guild;
  if (!guild) return;

  const member = message.member ?? await guild.members.fetch(message.author.id).catch(() => null);
  if (!member?.permissions.has(PermissionFlagsBits.ManageGuild)) {
    await reply(message, "You need Manage Server permission to configure guild-tag roles.");
    return;
  }

  const action = message.content.trim().split(/\s+/, 2)[1]?.toLowerCase() ?? "status";
  try {
    if (action === "set") {
      const role = message.mentions.roles.first();
      const channel = message.mentions.channels.first();
      if (!role || !channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
        await reply(message, "Usage: `!guildtagrole set @role #logs`");
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

      await db.insert(botGuildTagRolesTable)
        .values({ guildId: guild.id, roleId: role.id, logChannelId: channel.id })
        .onConflictDoUpdate({
          target: botGuildTagRolesTable.guildId,
          set: { roleId: role.id, logChannelId: channel.id, updatedAt: new Date() },
        });
      await reply(message, `Guild-tag role ${role} is set. Adds and removals will be logged in ${channel}.`);
      return;
    }

    if (action === "status") {
      const [settings] = await db.select()
        .from(botGuildTagRolesTable)
        .where(eq(botGuildTagRolesTable.guildId, guild.id))
        .limit(1);
      await reply(message, settings
        ? `Guild-tag role: <@&${settings.roleId}>\nLogs: <#${settings.logChannelId}>`
        : "Guild-tag role is not configured. Use `!guildtagrole set @role #logs`.");
      return;
    }

    if (action === "remove" || action === "disable") {
      const removed = await db.delete(botGuildTagRolesTable)
        .where(eq(botGuildTagRolesTable.guildId, guild.id))
        .returning({ guildId: botGuildTagRolesTable.guildId });
      await reply(message, removed.length
        ? "Guild-tag role automation has been disabled."
        : "Guild-tag role automation was not configured.");
      return;
    }

    await reply(message, "Usage: `!guildtagrole set @role #logs`, `!guildtagrole status`, or `!guildtagrole remove`.");
  } catch (error) {
    logger.error({ err: error, guildId: guild.id }, "Guild-tag role command failed");
    await reply(message, "Could not update guild-tag role settings. Please try again.").catch(() => {});
  }
}

function hasGuildTag(primaryGuild: User["primaryGuild"], guildId: string): boolean {
  return primaryGuild?.identityGuildId === guildId &&
    primaryGuild.identityEnabled === true &&
    Boolean(primaryGuild.tag);
}

async function sendGuildTagRoleLog(
  guild: NonNullable<ReturnType<Client["guilds"]["cache"]["get"]>>,
  channelId: string,
  userId: string,
  roleId: string,
  added: boolean,
): Promise<void> {
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) return;

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(added ? 0x57F287 : 0xED4245)
        .setTitle(added ? "Guild Tag Role Added" : "Guild Tag Role Removed")
        .setDescription(added
          ? `<@${userId}> added this server's guild tag and received <@&${roleId}>.`
          : `<@${userId}> removed this server's guild tag and lost <@&${roleId}>.`),
    ],
    allowedMentions: { parse: [] },
  });
}

export async function handleGuildTagRoleUserUpdate(
  client: Client,
  oldUser: User | PartialUser,
  newUser: User,
): Promise<void> {
  if (newUser.bot) return;

  const oldPrimaryGuild = "primaryGuild" in oldUser ? oldUser.primaryGuild : null;
  const newPrimaryGuild = newUser.primaryGuild;
  if (
    oldPrimaryGuild?.identityGuildId === newPrimaryGuild?.identityGuildId &&
    oldPrimaryGuild?.identityEnabled === newPrimaryGuild?.identityEnabled &&
    oldPrimaryGuild?.tag === newPrimaryGuild?.tag
  ) return;

  const guildIds = new Set(
    [oldPrimaryGuild?.identityGuildId, newPrimaryGuild?.identityGuildId]
      .filter((id): id is string => Boolean(id)),
  );
  for (const guildId of guildIds) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;

    const [settings] = await db.select()
      .from(botGuildTagRolesTable)
      .where(eq(botGuildTagRolesTable.guildId, guild.id))
      .limit(1);
    if (!settings) continue;

    const previouslyHadTag = hasGuildTag(oldPrimaryGuild, guild.id);
    const currentlyHasTag = hasGuildTag(newPrimaryGuild, guild.id);
    if (previouslyHadTag === currentlyHasTag) continue;

    const member = guild.members.cache.get(newUser.id) ?? await guild.members.fetch(newUser.id).catch(() => null);
    const role = await guild.roles.fetch(settings.roleId).catch(() => null);
    if (!member || !role) continue;

    if (currentlyHasTag && !member.roles.cache.has(role.id)) {
      await member.roles.add(role, "Member enabled this server's guild tag");
      await sendGuildTagRoleLog(guild, settings.logChannelId, member.id, role.id, true);
    } else if (!currentlyHasTag && member.roles.cache.has(role.id)) {
      await member.roles.remove(role, "Member disabled this server's guild tag");
      await sendGuildTagRoleLog(guild, settings.logChannelId, member.id, role.id, false);
    }
  }
}