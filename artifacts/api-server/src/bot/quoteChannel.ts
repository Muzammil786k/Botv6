import { ChannelType, PermissionFlagsBits, type Message } from "discord.js";
import { eq } from "drizzle-orm";
import { botQuoteRolesTable, botQuoteSettingsTable, db } from "@workspace/db";
import { logger } from "../lib/logger";

const CACHE_MS = 15_000;
const quoteChannelCache = new Map<string, { expiresAt: number; channelId: string | null }>();
const quoteRoleCache = new Map<string, { expiresAt: number; roleIds: string[] | null }>();

function parseRoleIds(value: string | undefined): string[] | null | undefined {
  if (value === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) {
      const roleIds = parsed.filter((id): id is string => typeof id === "string" && /^\d{17,20}$/.test(id));
      return roleIds.length > 0 ? roleIds : undefined;
    }
  } catch {}
  return undefined;
}

async function getQuoteRoleIds(guildId: string): Promise<string[] | null | undefined> {
  const cached = quoteRoleCache.get(guildId);
  if (cached && cached.expiresAt > Date.now()) return cached.roleIds;

  try {
    const [setting] = await db.select({ roleIds: botQuoteRolesTable.requiredRoleIds })
      .from(botQuoteRolesTable)
      .where(eq(botQuoteRolesTable.guildId, guildId))
      .limit(1);
    const roleIds = parseRoleIds(setting?.roleIds);
    if (roleIds === undefined) {
      logger.error({ guildId }, "Invalid quote role configuration");
      return undefined;
    }
    quoteRoleCache.set(guildId, { expiresAt: Date.now() + CACHE_MS, roleIds });
    return roleIds;
  } catch (err) {
    logger.error({ err, guildId }, "Failed to load quote role requirement");
    return undefined;
  }
}

async function getQuoteChannelId(guildId: string): Promise<string | null | undefined> {
  const cached = quoteChannelCache.get(guildId);
  if (cached && cached.expiresAt > Date.now()) return cached.channelId;

  try {
    const [setting] = await db.select({ channelId: botQuoteSettingsTable.channelId })
      .from(botQuoteSettingsTable)
      .where(eq(botQuoteSettingsTable.guildId, guildId))
      .limit(1);
    const channelId = setting?.channelId ?? null;
    quoteChannelCache.set(guildId, { expiresAt: Date.now() + CACHE_MS, channelId });
    return channelId;
  } catch (err) {
    logger.error({ err, guildId }, "Failed to load quote channel setting");
    return undefined;
  }
}

export async function requireQuoteChannel(message: Message): Promise<boolean> {
  const guild = message.guild;
  if (!guild) return false;

  const channelId = await getQuoteChannelId(guild.id);
  if (channelId === undefined) {
    await message.reply("❌ Could not verify the quote channel. Please try again shortly.");
    return false;
  }
  if (!channelId) {
    await message.reply("❌ Quote cards aren't configured. A server admin can set the channel with `!setquote #channel`.");
    return false;
  }
  if (message.channel.id !== channelId) {
    await message.reply(`❌ Quote cards can only be created in <#${channelId}>.`);
    return false;
  }

  const requiredRoleIds = await getQuoteRoleIds(guild.id);
  if (requiredRoleIds === undefined) {
    await message.reply("❌ Could not verify the quote role requirement. Please try again shortly.");
    return false;
  }
  if (requiredRoleIds) {
    const member = message.member ?? await guild.members.fetch(message.author.id).catch(() => null);
    if (member && requiredRoleIds.some((roleId) => member.roles.cache.has(roleId))) return true;
    await message.reply({
      content: `❌ You need one of these roles to create quote cards: ${requiredRoleIds.map((roleId) => `<@&${roleId}>`).join(" or ")}.`,
      allowedMentions: { parse: [] },
    });
    return false;
  }
  return true;
}

function parseRoleId(value: string): string | null {
  return /^<@&(\d{17,20})>$/.exec(value)?.[1] ?? (/^\d{17,20}$/.test(value) ? value : null);
}

export async function handleQuoteRoleCommand(message: Message, args: string[]): Promise<void> {
  const guild = message.guild;
  if (!guild) return;

  const manager = message.member ?? await guild.members.fetch(message.author.id).catch(() => null);
  if (!manager?.permissions.has(PermissionFlagsBits.ManageGuild) && !manager?.permissions.has(PermissionFlagsBits.Administrator)) {
    await message.reply("❌ You need **Manage Server** permission to configure quote roles.");
    return;
  }

  const action = args[0]?.toLowerCase() ?? "status";
  try {
    if (action === "set") {
      const roleIds = [...new Set([
        ...message.mentions.roles.keys(),
        ...args.slice(1).map((value) => parseRoleId(value.replace(/,$/, ""))).filter((id): id is string => id !== null),
      ])];
      if (roleIds.length === 0 || roleIds.length > 10) {
        await message.reply("❌ Mention 1–10 server roles. Usage: `!quoterole set @role1 @role2`.");
        return;
      }
      const roles = await Promise.all(roleIds.map((id) => guild.roles.fetch(id).catch(() => null)));
      if (roles.some((role) => !role || role.id === guild.id)) {
        await message.reply("❌ All entries must be valid server roles.");
        return;
      }

      await db.insert(botQuoteRolesTable)
        .values({ guildId: guild.id, requiredRoleIds: JSON.stringify(roleIds) })
        .onConflictDoUpdate({
          target: botQuoteRolesTable.guildId,
          set: { requiredRoleIds: JSON.stringify(roleIds), updatedAt: new Date() },
        });
      quoteRoleCache.set(guild.id, { expiresAt: Date.now() + CACHE_MS, roleIds });
      await message.reply(`✅ Quote cards now require any one of these roles: ${roles.join(", ")}.`);
      return;
    }

    if (action === "remove" || action === "clear" || action === "off") {
      await db.delete(botQuoteRolesTable).where(eq(botQuoteRolesTable.guildId, guild.id));
      quoteRoleCache.set(guild.id, { expiresAt: Date.now() + CACHE_MS, roleIds: null });
      await message.reply("✅ Quote role requirement removed.");
      return;
    }

    if (action === "status") {
      const roleIds = await getQuoteRoleIds(guild.id);
      if (roleIds === undefined) {
        await message.reply("❌ Could not read the quote role setting. Please try again shortly.");
        return;
      }
      await message.reply(roleIds
        ? `🔒 Quote cards require any one of these roles: ${roleIds.map((id) => `<@&${id}>`).join(", ")}.`
        : "🔓 Everyone can create quote cards. Use `!quoterole set @role1 @role2` to restrict access.");
      return;
    }

    await message.reply("Usage: `!quoterole set @role1 @role2`, `!quoterole status`, or `!quoterole remove`.");
  } catch (err) {
    logger.error({ err, guildId: guild.id, action }, "Failed to configure quote roles");
    await message.reply("❌ Could not update the quote role setting. Please try again.").catch(() => {});
  }
}

export async function handleSetQuoteCommand(message: Message, args: string[]): Promise<void> {
  const guild = message.guild;
  if (!guild) return;

  const member = message.member ?? await guild.members.fetch(message.author.id).catch(() => null);
  if (!member?.permissions.has(PermissionFlagsBits.ManageGuild) && !member?.permissions.has(PermissionFlagsBits.Administrator)) {
    await message.reply("❌ You need **Manage Server** permission to configure the quote channel.");
    return;
  }

  const action = args[0]?.toLowerCase();
  if (action === "remove" || action === "clear" || action === "off") {
    try {
      await db.delete(botQuoteSettingsTable).where(eq(botQuoteSettingsTable.guildId, guild.id));
      quoteChannelCache.set(guild.id, { expiresAt: Date.now() + CACHE_MS, channelId: null });
      await message.reply("✅ Quote channel removed. Quote cards are disabled until a channel is set again.");
    } catch (err) {
      logger.error({ err, guildId: guild.id }, "Failed to remove quote channel setting");
      await message.reply("❌ Could not remove the quote channel. Please try again.");
    }
    return;
  }

  const mentionedChannel = message.mentions.channels.first();
  const channelId = mentionedChannel?.id ?? /^<?#?(\d{17,20})>?$/.exec(args[0] ?? "")?.[1];
  if (!channelId) {
    const configuredChannel = await getQuoteChannelId(guild.id);
    if (action === "status" || !args[0]) {
      await message.reply(configuredChannel === undefined
        ? "❌ Could not load the quote channel setting."
        : configuredChannel
          ? `🖤 Quote cards are restricted to <#${configuredChannel}>.`
          : "🖤 No quote channel is set. Use `!setquote #channel`.");
      return;
    }
    await message.reply("Usage: `!setquote #channel`, `!setquote status`, or `!setquote remove`.");
    return;
  }

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) {
    await message.reply("❌ Choose a server text channel. Usage: `!setquote #channel`.");
    return;
  }

  try {
    await db.insert(botQuoteSettingsTable)
      .values({ guildId: guild.id, channelId: channel.id })
      .onConflictDoUpdate({
        target: botQuoteSettingsTable.guildId,
        set: { channelId: channel.id, updatedAt: new Date() },
      });
    quoteChannelCache.set(guild.id, { expiresAt: Date.now() + CACHE_MS, channelId: channel.id });
    await message.reply(`✅ Quote cards are now restricted to ${channel}.`);
  } catch (err) {
    logger.error({ err, guildId: guild.id, channelId }, "Failed to set quote channel");
    await message.reply("❌ Could not save the quote channel. Please try again.");
  }
}