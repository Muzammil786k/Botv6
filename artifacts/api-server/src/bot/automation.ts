import { and, eq } from "drizzle-orm";
import { EmbedBuilder } from "discord.js";
import type { Client, GuildMember, Message, PartialGuildMember } from "discord.js";
import {
  db,
  botChannelAutomationsTable,
  botCustomEmbedsTable,
  botGuildMessagesTable,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { premiumColors, premiumEmbed } from "./presentation";

const SETTINGS_CACHE_MS = 15_000;
const MAX_STICKY_CONTENT_LENGTH = 1_500;
const channelSettingsCache = new Map<
  string,
  { expiresAt: number; value: typeof botChannelAutomationsTable.$inferSelect | null }
>();
const stickyQueues = new Map<string, Promise<void>>();

function cacheKey(guildId: string, channelId: string): string {
  return `${guildId}:${channelId}`;
}

export async function getChannelAutomationSettings(guildId: string, channelId: string) {
  const key = cacheKey(guildId, channelId);
  const cached = channelSettingsCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const [settings] = await db
    .select()
    .from(botChannelAutomationsTable)
    .where(
      and(
        eq(botChannelAutomationsTable.guildId, guildId),
        eq(botChannelAutomationsTable.channelId, channelId),
      ),
    )
    .limit(1);

  const value = settings ?? null;
  channelSettingsCache.set(key, { value, expiresAt: Date.now() + SETTINGS_CACHE_MS });
  return value;
}

function invalidateChannelSettings(guildId: string, channelId: string): void {
  channelSettingsCache.delete(cacheKey(guildId, channelId));
}

export async function setChannelAutoReact(
  guildId: string,
  channelId: string,
  emoji: string,
  triggerText?: string,
): Promise<void> {
  const storedEmoji = triggerText
    ? `contains|${encodeURIComponent(triggerText)}|${emoji}`
    : emoji;
  await db
    .insert(botChannelAutomationsTable)
    .values({ guildId, channelId, autoReactEmoji: storedEmoji })
    .onConflictDoUpdate({
      target: [botChannelAutomationsTable.guildId, botChannelAutomationsTable.channelId],
      set: { autoReactEmoji: storedEmoji, updatedAt: new Date() },
    });
  invalidateChannelSettings(guildId, channelId);
}

function parseAutoReact(value: string): { emoji: string; triggerText: string | null } | null {
  if (value.startsWith("contains|")) {
    const separatorIndex = value.indexOf("|", "contains|".length);
    if (separatorIndex < 0) return null;
    try {
      const triggerText = decodeURIComponent(value.slice("contains|".length, separatorIndex));
      const emoji = value.slice(separatorIndex + 1);
      return triggerText && emoji ? { emoji, triggerText } : null;
    } catch {
      return null;
    }
  }
  if (value.startsWith("levelup|")) {
    const emoji = value.slice("levelup|".length);
    return emoji ? { emoji, triggerText: "level up" } : null;
  }
  if (value.includes("|")) return null;
  return { emoji: value, triggerText: null };
}

export function describeAutoReact(value: string): string | null {
  const setting = parseAutoReact(value);
  if (!setting) return null;
  return setting.triggerText
    ? `${setting.emoji} when a message contains “${setting.triggerText}”`
    : `${setting.emoji} on every user message`;
}

export async function removeChannelAutoReact(
  guildId: string,
  channelId: string,
): Promise<boolean> {
  const settings = await getChannelAutomationSettings(guildId, channelId);
  if (!settings?.autoReactEmoji) return false;

  if (!settings.stickyContent && !settings.autoResponseTrigger && !settings.autoResponseContent) {
    await db
      .delete(botChannelAutomationsTable)
      .where(
        and(
          eq(botChannelAutomationsTable.guildId, guildId),
          eq(botChannelAutomationsTable.channelId, channelId),
        ),
      );
  } else {
    await db
      .update(botChannelAutomationsTable)
      .set({ autoReactEmoji: null, updatedAt: new Date() })
      .where(
        and(
          eq(botChannelAutomationsTable.guildId, guildId),
          eq(botChannelAutomationsTable.channelId, channelId),
        ),
      );
  }
  invalidateChannelSettings(guildId, channelId);
  return true;
}

export async function setChannelAutoResponder(
  guildId: string,
  channelId: string,
  trigger: string,
  response: string,
): Promise<void> {
  await db
    .insert(botChannelAutomationsTable)
    .values({ guildId, channelId, autoResponseTrigger: trigger, autoResponseContent: response })
    .onConflictDoUpdate({
      target: [botChannelAutomationsTable.guildId, botChannelAutomationsTable.channelId],
      set: { autoResponseTrigger: trigger, autoResponseContent: response, updatedAt: new Date() },
    });
  invalidateChannelSettings(guildId, channelId);
}

export async function removeChannelAutoResponder(
  guildId: string,
  channelId: string,
): Promise<boolean> {
  const settings = await getChannelAutomationSettings(guildId, channelId);
  if (!settings?.autoResponseTrigger && !settings?.autoResponseContent) return false;

  if (!settings.stickyContent && !settings.autoReactEmoji) {
    await db
      .delete(botChannelAutomationsTable)
      .where(and(
        eq(botChannelAutomationsTable.guildId, guildId),
        eq(botChannelAutomationsTable.channelId, channelId),
      ));
  } else {
    await db
      .update(botChannelAutomationsTable)
      .set({ autoResponseTrigger: null, autoResponseContent: null, updatedAt: new Date() })
      .where(and(
        eq(botChannelAutomationsTable.guildId, guildId),
        eq(botChannelAutomationsTable.channelId, channelId),
      ));
  }
  invalidateChannelSettings(guildId, channelId);
  return true;
}

export async function setChannelSticky(
  guildId: string,
  channelId: string,
  content: string,
): Promise<void> {
  await db
    .insert(botChannelAutomationsTable)
    .values({ guildId, channelId, stickyContent: content })
    .onConflictDoUpdate({
      target: [botChannelAutomationsTable.guildId, botChannelAutomationsTable.channelId],
      set: { stickyContent: content, updatedAt: new Date() },
    });
  invalidateChannelSettings(guildId, channelId);
}

export async function removeChannelSticky(
  guildId: string,
  channelId: string,
): Promise<{ removed: boolean; messageId: string | null }> {
  const settings = await getChannelAutomationSettings(guildId, channelId);
  if (!settings?.stickyContent) return { removed: false, messageId: null };

  if (!settings.autoReactEmoji && !settings.autoResponseTrigger && !settings.autoResponseContent) {
    await db
      .delete(botChannelAutomationsTable)
      .where(
        and(
          eq(botChannelAutomationsTable.guildId, guildId),
          eq(botChannelAutomationsTable.channelId, channelId),
        ),
      );
  } else {
    await db
      .update(botChannelAutomationsTable)
      .set({ stickyContent: null, stickyMessageId: null, updatedAt: new Date() })
      .where(
        and(
          eq(botChannelAutomationsTable.guildId, guildId),
          eq(botChannelAutomationsTable.channelId, channelId),
        ),
      );
  }
  invalidateChannelSettings(guildId, channelId);
  return { removed: true, messageId: settings.stickyMessageId };
}

export type GuildMessageKind = "welcome" | "goodbye" | "boost";

const guildMessageFields = {
  welcome: { channel: "welcomeChannelId", template: "welcomeTemplate" },
  goodbye: { channel: "goodbyeChannelId", template: "goodbyeTemplate" },
  boost: { channel: "boostChannelId", template: "boostTemplate" },
} as const;

export async function setGuildMessage(
  guildId: string,
  kind: GuildMessageKind,
  channelId: string,
  template: string,
): Promise<void> {
  const { channel: channelField, template: templateField } = guildMessageFields[kind];
  await db
    .insert(botGuildMessagesTable)
    .values({
      guildId,
      [channelField]: channelId,
      [templateField]: template,
    })
    .onConflictDoUpdate({
      target: botGuildMessagesTable.guildId,
      set: {
        [channelField]: channelId,
        [templateField]: template,
        updatedAt: new Date(),
      },
    });
}

export async function removeGuildMessage(
  guildId: string,
  kind: GuildMessageKind,
): Promise<boolean> {
  const [settings] = await db
    .select()
    .from(botGuildMessagesTable)
    .where(eq(botGuildMessagesTable.guildId, guildId))
    .limit(1);
  if (!settings) return false;

  const fields = guildMessageFields[kind];
  if (!settings[fields.channel] && !settings[fields.template]) return false;

  const stillUsed = (Object.keys(guildMessageFields) as GuildMessageKind[])
    .filter((other) => other !== kind)
    .some((other) =>
      settings[guildMessageFields[other].channel] || settings[guildMessageFields[other].template]);

  if (!stillUsed) {
    await db
      .delete(botGuildMessagesTable)
      .where(eq(botGuildMessagesTable.guildId, guildId));
  } else {
    await db
      .update(botGuildMessagesTable)
      .set({
        [fields.channel]: null,
        [fields.template]: null,
        ...(kind === "boost" ? { boostTitle: null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(botGuildMessagesTable.guildId, guildId));
  }
  return true;
}

async function getTextChannel(client: Client, guildId: string, channelId: string) {
  const cachedGuildChannel = client.guilds.cache.get(guildId)?.channels.cache.get(channelId);
  const channel =
    cachedGuildChannel ??
    (await client.channels.fetch(channelId).catch(() => null));
  if (!channel?.isTextBased() || !("guildId" in channel) || channel.guildId !== guildId) {
    return null;
  }
  return channel;
}

async function bumpStickyMessage(
  client: Client,
  guildId: string,
  channelId: string,
): Promise<void> {
  const settings = await getChannelAutomationSettings(guildId, channelId);
  if (!settings?.stickyContent) return;
  const channel = await getTextChannel(client, guildId, channelId);
  if (!channel) return;

  if (settings.stickyMessageId) {
    const previous = await channel.messages.fetch(settings.stickyMessageId).catch(() => null);
    if (previous && previous.author.id === client.user?.id) {
      try {
        await previous.delete();
      } catch (error) {
        logger.warn(
          { err: error, guildId, channelId },
          "Could not move the sticky message; check the bot's channel permissions",
        );
        return;
      }
    }
  }

  const sent = await channel.send({
    embeds: [
      premiumEmbed(
        settings.stickyContent,
        { title: "📌 Sticky message", color: premiumColors.brand },
        client.user,
      ),
    ],
    allowedMentions: { parse: [] },
  });

  await db
    .update(botChannelAutomationsTable)
    .set({ stickyMessageId: sent.id, updatedAt: new Date() })
    .where(
      and(
        eq(botChannelAutomationsTable.guildId, guildId),
        eq(botChannelAutomationsTable.channelId, channelId),
      ),
    );
  invalidateChannelSettings(guildId, channelId);
}

export async function bumpStickyForChannel(
  client: Client,
  guildId: string,
  channelId: string,
): Promise<void> {
  const key = cacheKey(guildId, channelId);
  const previous = stickyQueues.get(key) ?? Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(() => bumpStickyMessage(client, guildId, channelId))
    .catch((error: unknown) => {
      logger.warn({ err: error, guildId, channelId }, "Sticky message update failed");
    });
  stickyQueues.set(key, current);
  await current;
  if (stickyQueues.get(key) === current) stickyQueues.delete(key);
}

export async function processUserMessageAutomations(
  client: Client,
  message: Message,
): Promise<void> {
  if (!message.guild || message.webhookId) return;

  try {
    const settings = await getChannelAutomationSettings(
      message.guild.id,
      message.channelId,
    );
    if (!settings) return;

    if (settings.autoReactEmoji) {
      const autoReact = parseAutoReact(settings.autoReactEmoji);
      const triggerMatches = autoReact?.triggerText
        ? message.content.toLowerCase().includes(autoReact.triggerText.toLowerCase())
        : autoReact !== null && !message.author.bot;
      if (autoReact && triggerMatches) {
        await message.react(autoReact.emoji).catch((error: unknown) => {
          logger.warn(
            { err: error, guildId: message.guildId, channelId: message.channelId },
            "Auto-react failed",
          );
        });
      }
    }

    if (
      settings.autoResponseTrigger &&
      settings.autoResponseContent &&
      !message.author.bot &&
      !message.content.trimStart().startsWith("!")
    ) {
      const escapedTrigger = settings.autoResponseTrigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const triggerPattern = new RegExp(
        `(^|[^\\p{L}\\p{N}_])${escapedTrigger}(?=$|[^\\p{L}\\p{N}_])`,
        "iu",
      );
      if (triggerPattern.test(message.content)) {
        await message.reply({
          content: settings.autoResponseContent,
          allowedMentions: { parse: [] },
        });
      }
    }

    if (settings.stickyContent && !message.author.bot) {
      await bumpStickyForChannel(client, message.guild.id, message.channelId);
    }
  } catch (error) {
    logger.error(
      { err: error, guildId: message.guild.id, channelId: message.channelId },
      "Could not load channel automation settings",
    );
  }
}

function renderMemberTemplate(
  template: string,
  member: GuildMember | PartialGuildMember,
): string {
  return template
    .replaceAll("{user}", `<@${member.id}>`)
    .replaceAll("{user_tag}", member.displayName ?? member.user?.username ?? "Unknown")
    .replaceAll("{server}", member.guild.name)
    .replaceAll("{memberCount}", String(member.guild.memberCount))
    .replaceAll("{boostCount}", String(member.guild.premiumSubscriptionCount ?? 0))
    .slice(0, 4096);
}

export async function sendMemberMessage(
  client: Client,
  member: GuildMember | PartialGuildMember,
  kind: GuildMessageKind,
): Promise<void> {
  const [settings] = await db
    .select()
    .from(botGuildMessagesTable)
    .where(eq(botGuildMessagesTable.guildId, member.guild.id))
    .limit(1);
  if (!settings) return;

  const channelId = settings[guildMessageFields[kind].channel];
  const template = settings[guildMessageFields[kind].template];
  if (!channelId || !template) return;

  const channel = await getTextChannel(client, member.guild.id, channelId);
  if (!channel) {
    logger.warn(
      { guildId: member.guild.id, channelId },
      `${kind} message channel is unavailable`,
    );
    return;
  }

  const embedToken = kind !== "goodbye"
    ? /\{\{?embed:([a-z0-9_-]{1,32})\}\}?/i.exec(template)
    : null;
  const customEmbedName = embedToken?.[1]?.toLowerCase();
  if (customEmbedName) {
    const [custom] = await db
      .select()
      .from(botCustomEmbedsTable)
      .where(and(
        eq(botCustomEmbedsTable.guildId, member.guild.id),
        eq(botCustomEmbedsTable.name, customEmbedName),
      ))
      .limit(1);
    if (!custom) {
      logger.warn(
        { guildId: member.guild.id, embedName: customEmbedName },
        "Configured welcome embed no longer exists",
      );
      return;
    }

    const render = (value: string, limit: number) =>
      renderMemberTemplate(value, member).slice(0, limit);
    const greeting = renderMemberTemplate(
      template.replace(/\{\{?embed:[a-z0-9_-]{1,32}\}\}?/gi, "").trim(),
      member,
    );
    const embed = new EmbedBuilder()
      .setTitle(custom.title
        ? render(custom.title, 256)
        : kind === "boost"
          ? `Thanks for boosting ${member.guild.name}`
          : `Welcome to ${member.guild.name}`)
      .setThumbnail(custom.thumbnailUrl ?? member.user.displayAvatarURL({ size: 256 }));
    if (custom.description) embed.setDescription(render(custom.description, 4096));
    if (custom.color) embed.setColor(Number.parseInt(custom.color.slice(1), 16));
    if (custom.imageUrl) embed.setImage(custom.imageUrl);
    if (custom.footerText) embed.setFooter({ text: render(custom.footerText, 2048) });
    if (custom.fields?.length) {
      embed.addFields(custom.fields.map((field) => ({
        name: render(field.name, 256),
        value: render(field.value, 1024),
        ...(field.inline === undefined ? {} : { inline: field.inline }),
      })));
    }
    await channel.send({
      ...(greeting ? { content: greeting } : {}),
      embeds: [embed],
      allowedMentions: { parse: [], users: [member.id] },
    });
    return;
  }

  const title =
    kind === "welcome"
      ? `Welcome to ${member.guild.name}`
      : kind === "boost"
        ? settings.boostTitle ?? `Thanks for boosting ${member.guild.name}`
        : `Goodbye from ${member.guild.name}`;
  await channel.send({
    embeds: [
      premiumEmbed(
        renderMemberTemplate(template, member),
        {
          title,
          thumbnail: member.user.displayAvatarURL({ size: 256 }),
          color: kind === "goodbye" ? premiumColors.warning : premiumColors.success,
        },
        client.user,
      ),
    ],
    allowedMentions: { parse: [], users: [member.id] },
  });
}

export const automationLimits = {
  maxStickyContentLength: MAX_STICKY_CONTENT_LENGTH,
  maxAutoResponseTriggerLength: 100,
  maxAutoResponseContentLength: 1_800,
} as const;
