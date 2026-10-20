import {
  ChannelType,
  PermissionFlagsBits,
  type Client,
  type GuildBasedChannel,
  type Message,
} from "discord.js";
import { and, eq } from "drizzle-orm";
import { botCustomEmbedsTable, db } from "@workspace/db";
import { logger } from "../lib/logger";
import {
  automationLimits,
  bumpStickyForChannel,
  describeAutoReact,
  getChannelAutomationSettings,
  removeChannelAutoResponder,
  removeChannelAutoReact,
  removeChannelSticky,
  removeGuildMessage,
  setChannelAutoReact,
  setChannelAutoResponder,
  setChannelSticky,
  setGuildMessage,
} from "./automation";

async function requireManageServer(message: Message): Promise<boolean> {
  const guild = message.guild;
  if (!guild) return false;
  const member =
    message.member ?? (await guild.members.fetch(message.author.id).catch(() => null));
  if (member?.permissions.has(PermissionFlagsBits.ManageGuild)) return true;

  await message.reply({
    content: "❌ You need **Manage Server** permission to change automation settings.",
    allowedMentions: { parse: [], repliedUser: false },
  });
  return false;
}

function mentionedTextChannel(message: Message): GuildBasedChannel | null {
  const guild = message.guild;
  const mentionedChannel = message.mentions.channels.first();
  if (!guild || !mentionedChannel) return null;
  const channel = guild.channels.cache.get(mentionedChannel.id);
  if (!channel || !channel.isTextBased()) return null;
  return channel;
}

function textAfterChannelMention(message: Message, channel: GuildBasedChannel): string {
  const mention = `<#${channel.id}>`;
  const mentionIndex = message.content.indexOf(mention);
  return mentionIndex < 0
    ? ""
    : message.content.slice(mentionIndex + mention.length).trim();
}

function isSingleUnicodeEmoji(value: string): boolean {
  return /^(?:\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*|[\u{1F1E6}-\u{1F1FF}]{2}|[0-9#*]\uFE0F?\u20E3)$/u.test(value);
}

async function saveFailure(message: Message, feature: string, error: unknown): Promise<void> {
  logger.error(
    { err: error, guildId: message.guild?.id, feature },
    "Could not save bot automation settings",
  );
  await message
    .reply({
      content: `❌ I couldn't save the ${feature} settings. Please try again.`,
      allowedMentions: { parse: [], repliedUser: false },
    })
    .catch(() => {});
}

function welcomeEmbedName(template: string): string | null {
  return /\{\{?embed:([a-z0-9_-]{1,32})\}\}?/i.exec(template)?.[1]?.toLowerCase() ?? null;
}

export async function handleAutoResponderCommand(message: Message): Promise<void> {
  if (!message.guild || !(await requireManageServer(message))) return;

  const action = message.content.trim().split(/\s+/)[1]?.toLowerCase();
  const channel = mentionedTextChannel(message);
  if (!channel) {
    await message.reply({
      content: "Usage: `!autoresponder set #channel trigger => response`, `!autoresponder status #channel`, or `!autoresponder remove #channel`.",
      allowedMentions: { parse: [], repliedUser: false },
    });
    return;
  }

  if (action === "set") {
    const config = textAfterChannelMention(message, channel);
    const separatorIndex = config.indexOf("=>");
    const rawTrigger = separatorIndex < 0 ? "" : config.slice(0, separatorIndex).trim();
    const quotedTrigger = /^(?:"([\s\S]*)"|'([\s\S]*)')$/.exec(rawTrigger);
    const trigger = (quotedTrigger?.[1] ?? quotedTrigger?.[2] ?? rawTrigger).trim();
    const response = separatorIndex < 0 ? "" : config.slice(separatorIndex + 2).trim();
    if (
      !trigger || trigger.length > automationLimits.maxAutoResponseTriggerLength ||
      !response || response.length > automationLimits.maxAutoResponseContentLength
    ) {
      await message.reply({
        content: `❌ Provide a trigger (up to ${automationLimits.maxAutoResponseTriggerLength} characters) and response (up to ${automationLimits.maxAutoResponseContentLength} characters). Example: \`!autoresponder set #chat hello => Hi there!\`.`,
        allowedMentions: { parse: [], repliedUser: false },
      });
      return;
    }

    try {
      await setChannelAutoResponder(message.guild.id, channel.id, trigger, response);
      await message.reply({
        content: `✅ Auto-responder in ${channel} will reply to **${trigger}**.`,
        allowedMentions: { parse: [], repliedUser: false },
      });
    } catch (error) {
      await saveFailure(message, "auto-responder", error);
    }
    return;
  }

  if (action === "status") {
    try {
      const settings = await getChannelAutomationSettings(message.guild.id, channel.id);
      await message.reply({
        content: settings?.autoResponseTrigger && settings.autoResponseContent
          ? `💬 Auto-responder is on in ${channel}. Trigger: **${settings.autoResponseTrigger}**\nResponse: ${settings.autoResponseContent}`
          : `ℹ️ Auto-responder is off in ${channel}.`,
        allowedMentions: { parse: [], repliedUser: false },
      });
    } catch (error) {
      await saveFailure(message, "auto-responder", error);
    }
    return;
  }

  if (action === "remove" || action === "disable") {
    try {
      const removed = await removeChannelAutoResponder(message.guild.id, channel.id);
      await message.reply({
        content: removed
          ? `✅ Auto-responder removed from ${channel}.`
          : `ℹ️ No auto-responder is configured in ${channel}.`,
        allowedMentions: { parse: [], repliedUser: false },
      });
    } catch (error) {
      await saveFailure(message, "auto-responder", error);
    }
    return;
  }

  await message.reply({
    content: "Usage: `!autoresponder set #channel trigger => response`, `!autoresponder status #channel`, or `!autoresponder remove #channel`.",
    allowedMentions: { parse: [], repliedUser: false },
  });
}

export async function handleAutoReactCommand(message: Message): Promise<void> {
  if (!message.guild || !(await requireManageServer(message))) return;

  const args = message.content.trim().split(/\s+/);
  const action = args[1]?.toLowerCase();
  const channel = mentionedTextChannel(message);
  if (!channel) {
    await message.reply({
      content:
        "❌ Mention a text channel. Usage: `!autoreact set #channel <emoji> [trigger text]`, `!autoreact remove #channel`, or `!autoreact status #channel`.",
      allowedMentions: { parse: [], repliedUser: false },
    });
    return;
  }

  if (action === "set") {
    const [emojiText = "", ...triggerParts] = textAfterChannelMention(message, channel).split(/\s+/);
    const rawTrigger = triggerParts.join(" ").trim();
    const quotedTrigger = /^(?:"([\s\S]*)"|'([\s\S]*)')$/.exec(rawTrigger);
    const triggerText = (quotedTrigger?.[1] ?? quotedTrigger?.[2] ?? rawTrigger).trim();
    if (triggerText.length > 120) {
      await message.reply({
        content: "❌ Auto-react trigger text must be 120 characters or fewer.",
        allowedMentions: { parse: [], repliedUser: false },
      });
      return;
    }
    const match = /^<a?:[A-Za-z0-9_]{2,32}:(\d{17,20})>$/.exec(emojiText);
    const emoji = match ? message.guild.emojis.cache.get(match[1]!) : undefined;
    if (!emoji && !isSingleUnicodeEmoji(emojiText)) {
      await message.reply({
        content:
          "❌ Use one Unicode emoji or a custom emoji from this server, for example `!autoreact set #chat 👍` or `!autoreact set #chat 🎉 \"level up\"`.",
        allowedMentions: { parse: [], repliedUser: false },
      });
      return;
    }

    const botMember = await message.guild.members.fetchMe().catch(() => null);
    const permissions = botMember ? channel.permissionsFor(botMember) : null;
    if (!permissions?.has(PermissionFlagsBits.ViewChannel) || !permissions.has(PermissionFlagsBits.AddReactions)) {
      await message.reply({
        content: `❌ I need **View Channel** and **Add Reactions** permissions in ${channel}.`,
        allowedMentions: { parse: [], repliedUser: false },
      });
      return;
    }

    try {
      const selectedEmoji = emoji?.toString() ?? emojiText;
      await setChannelAutoReact(message.guild.id, channel.id, selectedEmoji, triggerText || undefined);
      await message.reply({
        content: triggerText
          ? `✅ I’ll react with ${selectedEmoji} in ${channel} when a message contains “${triggerText}”.`
          : `✅ Auto-react is on in ${channel}. I’ll react to every new user message with ${selectedEmoji}.`,
        allowedMentions: { parse: [], repliedUser: false },
      });
    } catch (error) {
      await saveFailure(message, "auto-react", error);
    }
    return;
  }

  if (action === "remove" || action === "disable") {
    try {
      const removed = await removeChannelAutoReact(message.guild.id, channel.id);
      await message.reply({
        content: removed
          ? `✅ Auto-react is off in ${channel}.`
          : `ℹ️ Auto-react was not configured in ${channel}.`,
        allowedMentions: { parse: [], repliedUser: false },
      });
    } catch (error) {
      await saveFailure(message, "auto-react", error);
    }
    return;
  }

  if (action === "status") {
    try {
      const settings = await getChannelAutomationSettings(message.guild.id, channel.id);
      const autoReact = settings?.autoReactEmoji
        ? describeAutoReact(settings.autoReactEmoji)
        : null;
      await message.reply({
        content: autoReact
          ? `✨ Auto-react is on in ${channel}: ${autoReact}.`
          : `ℹ️ Auto-react is off in ${channel}.`,
        allowedMentions: { parse: [], repliedUser: false },
      });
    } catch (error) {
      await saveFailure(message, "auto-react", error);
    }
    return;
  }

  await message.reply({
    content:
      "ℹ️ Usage: `!autoreact set #channel <emoji> [trigger text]`, `!autoreact remove #channel`, or `!autoreact status #channel`.",
    allowedMentions: { parse: [], repliedUser: false },
  });
}

export async function handleStickyCommand(
  client: Client,
  message: Message,
): Promise<void> {
  if (!message.guild || !(await requireManageServer(message))) return;

  const args = message.content.trim().split(/\s+/);
  const action = args[1]?.toLowerCase();
  const channel = mentionedTextChannel(message);
  if (!channel) {
    await message.reply({
      content:
        "❌ Mention a text channel. Usage: `!sticky set #channel <message>` or `!sticky remove #channel`.",
      allowedMentions: { parse: [], repliedUser: false },
    });
    return;
  }

  if (action === "status") {
    try {
      const settings = await getChannelAutomationSettings(message.guild.id, channel.id);
      await message.reply({
        content: settings?.stickyContent
          ? `📌 Sticky message is on in ${channel}. Current message: ${settings.stickyContent}`
          : `ℹ️ No sticky message is configured in ${channel}.`,
        allowedMentions: { parse: [], repliedUser: false },
      });
    } catch (error) {
      await saveFailure(message, "sticky message", error);
    }
    return;
  }

  if (action === "set") {
    const content = textAfterChannelMention(message, channel);
    if (!content || content.length > automationLimits.maxStickyContentLength) {
      await message.reply({
        content: `❌ Sticky text must be between 1 and ${automationLimits.maxStickyContentLength} characters.`,
        allowedMentions: { parse: [], repliedUser: false },
      });
      return;
    }

    const botMember = await message.guild.members.fetchMe().catch(() => null);
    const permissions = botMember ? channel.permissionsFor(botMember) : null;
    const isThread =
      channel.type === ChannelType.AnnouncementThread ||
      channel.type === ChannelType.PublicThread ||
      channel.type === ChannelType.PrivateThread;
    const sendPermission = isThread
      ? PermissionFlagsBits.SendMessagesInThreads
      : PermissionFlagsBits.SendMessages;
    if (
      !permissions?.has(PermissionFlagsBits.ViewChannel) ||
      !permissions.has(sendPermission) ||
      !permissions.has(PermissionFlagsBits.EmbedLinks)
    ) {
      await message.reply({
        content: `❌ I need **View Channel**, **${isThread ? "Send Messages in Threads" : "Send Messages"}**, and **Embed Links** permissions in ${channel} to keep a sticky message there.`,
        allowedMentions: { parse: [], repliedUser: false },
      });
      return;
    }

    try {
      await setChannelSticky(message.guild.id, channel.id, content);
      await message.reply({
        content: `✅ Sticky message set for ${channel}. It will be moved to the bottom after each new message.`,
        allowedMentions: { parse: [], repliedUser: false },
      });
    } catch (error) {
      await saveFailure(message, "sticky message", error);
    }
    return;
  }

  if (action === "remove" || action === "disable") {
    try {
      const result = await removeChannelSticky(message.guild.id, channel.id);
      if (result.messageId) {
        const stickyChannel = await client.channels.fetch(channel.id).catch(() => null);
        if (stickyChannel?.isTextBased() && "guildId" in stickyChannel) {
          const sticky = await stickyChannel.messages.fetch(result.messageId).catch(() => null);
          if (sticky && sticky.author.id === client.user?.id) {
            await sticky.delete().catch((error: unknown) => {
              logger.warn(
                { err: error, guildId: message.guild?.id, channelId: channel.id },
                "Could not delete the old sticky message",
              );
            });
          }
        }
      }
      await message.reply({
        content: result.removed
          ? `✅ Sticky message removed from ${channel}.`
          : `ℹ️ No sticky message was configured in ${channel}.`,
        allowedMentions: { parse: [], repliedUser: false },
      });
    } catch (error) {
      await saveFailure(message, "sticky message", error);
    }
    return;
  }

  await message.reply({
    content: "ℹ️ Usage: `!sticky set #channel <message>` or `!sticky remove #channel`.",
    allowedMentions: { parse: [], repliedUser: false },
  });
}

async function handleMemberMessageCommand(
  message: Message,
  kind: "welcome" | "goodbye",
): Promise<void> {
  if (!message.guild || !(await requireManageServer(message))) return;

  const args = message.content.trim().split(/\s+/);
  const action = args[1]?.toLowerCase();
  if (kind === "welcome" && action === "embed") {
    const channel = mentionedTextChannel(message);
    const embedName = (args[3] ?? "welcome").toLowerCase();
    if (!channel || !/^[a-z0-9_-]{1,32}$/.test(embedName)) {
      await message.reply({
        content: "ℹ️ Usage: `!welcome embed #channel [embed-name]` (default embed name: `welcome`).",
        allowedMentions: { parse: [], repliedUser: false },
      });
      return;
    }

    const [savedEmbed] = await db
      .select({ name: botCustomEmbedsTable.name })
      .from(botCustomEmbedsTable)
      .where(and(
        eq(botCustomEmbedsTable.guildId, message.guild.id),
        eq(botCustomEmbedsTable.name, embedName),
      ))
      .limit(1);
    if (!savedEmbed) {
      await message.reply({
        content: `❌ Embed \`${embedName}\` not found. Create it first with \`!embed create ${embedName}\`.`,
        allowedMentions: { parse: [], repliedUser: false },
      });
      return;
    }

    try {
      await setGuildMessage(message.guild.id, "welcome", channel.id, `{{embed:${embedName}}}`);
      await message.reply({
        content: `✅ Welcome embed \`${embedName}\` set in ${channel}. Preview or edit it with \`!embed show ${embedName}\` and \`!embed edit ${embedName} <field> <value>\`.`,
        allowedMentions: { parse: [], repliedUser: false },
      });
    } catch (error) {
      await saveFailure(message, "welcome embed", error);
    }
    return;
  }

  if (action === "remove" || action === "disable" || action === "off") {
    try {
      const removed = await removeGuildMessage(message.guild.id, kind);
      await message.reply({
        content: removed
          ? `✅ ${kind === "welcome" ? "Welcome" : "Goodbye"} messages are off.`
          : `ℹ️ No ${kind} message was configured.`,
        allowedMentions: { parse: [], repliedUser: false },
      });
    } catch (error) {
      await saveFailure(message, `${kind} message`, error);
    }
    return;
  }

  const channel = mentionedTextChannel(message);
  const template = channel ? textAfterChannelMention(message, channel) : "";
  if (action !== "set" || !channel || !template || template.length > 1_800) {
    await message.reply({
      content:
        `ℹ️ Usage: \`!${kind} set #channel <message>\` or \`!${kind} remove\`.\n` +
        "Placeholders: `{user}`, `{server}`, and `{memberCount}`.",
      allowedMentions: { parse: [], repliedUser: false },
    });
    return;
  }

  const embedName = kind === "welcome" ? welcomeEmbedName(template) : null;
  if (embedName) {
    const [savedEmbed] = await db
      .select({ name: botCustomEmbedsTable.name })
      .from(botCustomEmbedsTable)
      .where(and(
        eq(botCustomEmbedsTable.guildId, message.guild.id),
        eq(botCustomEmbedsTable.name, embedName),
      ))
      .limit(1);
    if (!savedEmbed) {
      await message.reply({
        content: `❌ Embed \`${embedName}\` not found. Create it first with \`!embed create ${embedName}\`.`,
        allowedMentions: { parse: [], repliedUser: false },
      });
      return;
    }
  }

  try {
    await setGuildMessage(message.guild.id, kind, channel.id, template);
    await message.reply({
      content:
        `✅ ${kind === "welcome" ? "Welcome" : "Goodbye"} message set in ${channel}.\n` +
        `Placeholders {user}, {server}, and {memberCount} will be filled in automatically.${embedName ? ` Embed \`${embedName}\` will also be included.` : ""}`,
      allowedMentions: { parse: [], repliedUser: false },
    });
  } catch (error) {
    await saveFailure(message, `${kind} message`, error);
  }
}

export function handleWelcomeCommand(message: Message): Promise<void> {
  return handleMemberMessageCommand(message, "welcome");
}
