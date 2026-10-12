import { ChannelType, PermissionFlagsBits, type Message, type TextChannel } from "discord.js";
import { eq } from "drizzle-orm";
import { botGameSettingsTable, db } from "@workspace/db";
import { logger } from "../lib/logger";

const CONFIG_CACHE_MS = 15_000;
const gameChannelCache = new Map<string, { expiresAt: number; channelId: string | null }>();

async function getGameChannelId(guildId: string): Promise<string | null | undefined> {
  const cached = gameChannelCache.get(guildId);
  if (cached && cached.expiresAt > Date.now()) return cached.channelId;

  try {
    const [settings] = await db
      .select({ channelId: botGameSettingsTable.channelId })
      .from(botGameSettingsTable)
      .where(eq(botGameSettingsTable.guildId, guildId))
      .limit(1);
    const channelId = settings?.channelId ?? null;
    gameChannelCache.set(guildId, { expiresAt: Date.now() + CONFIG_CACHE_MS, channelId });
    return channelId;
  } catch (err) {
    logger.error({ err, guildId }, "Failed to load game channel setting");
    return undefined;
  }
}

export async function requireGameChannel(message: Message): Promise<boolean> {
  const guild = message.guild;
  if (!guild) return false;

  const channelId = await getGameChannelId(guild.id);
  if (channelId === undefined) {
    await message.reply("❌ Could not verify the game channel. Please try again shortly.");
    return false;
  }
  if (!channelId) {
    await message.reply("❌ Games are not configured. A server admin can set the channel with `!setgame #channel`.");
    return false;
  }
  if (message.channel.id !== channelId) {
    await message.reply(`❌ Games can only be played in <#${channelId}>.`);
    return false;
  }
  return true;
}

export async function handleSetGameCommand(message: Message, args: string[]): Promise<void> {
  const guild = message.guild;
  if (!guild) return;

  const member = message.member ?? await guild.members.fetch(message.author.id).catch(() => null);
  if (!member?.permissions.has(PermissionFlagsBits.ManageGuild) && !member?.permissions.has(PermissionFlagsBits.Administrator)) {
    await message.reply("❌ You need **Manage Server** permission to configure the game channel.");
    return;
  }

  const action = args[0]?.toLowerCase();
  if (action === "remove" || action === "clear" || action === "off") {
    try {
      await db.delete(botGameSettingsTable).where(eq(botGameSettingsTable.guildId, guild.id));
      gameChannelCache.set(guild.id, { expiresAt: Date.now() + CONFIG_CACHE_MS, channelId: null });
      await message.reply("✅ The game channel was cleared. Games are now disabled until another channel is set.");
    } catch (err) {
      logger.error({ err, guildId: guild.id }, "Failed to remove game channel setting");
      await message.reply("❌ Could not clear the game channel. Please try again.");
    }
    return;
  }

  const mentionedChannel = message.mentions.channels.first();
  const channelId = mentionedChannel?.id ?? /^<?#?(\d{17,20})>?$/.exec(args[0] ?? "")?.[1];
  if (!channelId) {
    const configuredChannel = await getGameChannelId(guild.id);
    if (action === "status" || !args[0]) {
      await message.reply(configuredChannel === undefined
        ? "❌ Could not load the game channel setting."
        : configuredChannel
          ? `🎮 Games are restricted to <#${configuredChannel}>.`
          : "🎮 No game channel is set. Use `!setgame #channel`.");
      return;
    }
    await message.reply("Usage: `!setgame #channel`, `!setgame status`, or `!setgame remove`.");
    return;
  }

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) {
    await message.reply("❌ Choose a server text channel. Usage: `!setgame #channel`.");
    return;
  }

  try {
    await db.insert(botGameSettingsTable)
      .values({ guildId: guild.id, channelId: channel.id })
      .onConflictDoUpdate({
        target: botGameSettingsTable.guildId,
        set: { channelId: channel.id, updatedAt: new Date() },
      });
    gameChannelCache.set(guild.id, { expiresAt: Date.now() + CONFIG_CACHE_MS, channelId: channel.id });
    await message.reply(`✅ Word Bomb and Truth or Dare are now restricted to ${channel as TextChannel}.`);
  } catch (err) {
    logger.error({ err, guildId: guild.id, channelId }, "Failed to set game channel");
    await message.reply("❌ Could not save the game channel. Please try again.");
  }
}