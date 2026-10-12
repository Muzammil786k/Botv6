import { ChannelType, PermissionFlagsBits, type Message } from "discord.js";
import { eq } from "drizzle-orm";
import { botQuoteSettingsTable, db } from "@workspace/db";
import { logger } from "../lib/logger";

const CACHE_MS = 15_000;
const quoteChannelCache = new Map<string, { expiresAt: number; channelId: string | null }>();

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
  return true;
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