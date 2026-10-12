import {
  EmbedBuilder,
  type Message,
} from "discord.js";

interface AfkEntry {
  status: string;
  since: number;
}

const afkUsers = new Map<string, AfkEntry>();

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (days) parts.push(`${days} day${days !== 1 ? "s" : ""}`);
  if (hours) parts.push(`${hours} hour${hours !== 1 ? "s" : ""}`);
  if (minutes) parts.push(`${minutes} minute${minutes !== 1 ? "s" : ""}`);
  if (seconds || parts.length === 0) parts.push(`${seconds} second${seconds !== 1 ? "s" : ""}`);

  if (parts.length === 1) return parts[0];
  return parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1];
}

export async function handleAfk(message: Message, transformedContent?: string): Promise<void> {
  const userId = message.author.id;

  if (afkUsers.has(userId)) {
    const entry = afkUsers.get(userId)!;
    const away = formatDuration(Date.now() - entry.since);
    afkUsers.delete(userId);
    await message.reply({
      suppressHelpFooter: true,
      embeds: [
        new EmbedBuilder()
          .setColor(0xff0000)
          .setDescription(`👋 <@${userId}>: Welcome back, you were away for **${away}**`),
      ],
      allowedMentions: { users: [userId] },
    });
    return;
  }

  const content = (transformedContent ?? message.content).trim();
  const isAfkCommand =
    content.toLowerCase() === "!afk" ||
    content.toLowerCase().startsWith("!afk ");

  if (isAfkCommand) {
    const status = content.slice(4).trim() || "AFK"; // slice past "!afk"
    const since = Date.now();
    afkUsers.set(userId, { status, since });
    await message.reply({
      suppressHelpFooter: true,
      embeds: [
        new EmbedBuilder()
          .setColor(0xff0000)
          .setDescription(`✅ <@${userId}>: You're now AFK with the status: **${status}**`),
      ],
      allowedMentions: { users: [userId] },
    });
    return;
  }

  for (const mentionedUser of message.mentions.users.values()) {
    if (afkUsers.has(mentionedUser.id)) {
      const entry = afkUsers.get(mentionedUser.id)!;
      const away = formatDuration(Date.now() - entry.since);
      await message.reply({
        suppressHelpFooter: true,
        embeds: [
          new EmbedBuilder()
            .setColor(0xff0000)
            .setDescription(`💤 <@${mentionedUser.id}> is AFK: **${entry.status}** — ${away} ago`),
        ],
        allowedMentions: { users: [] },
      });
    }
  }
}

export { afkUsers };
