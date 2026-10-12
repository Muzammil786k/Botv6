import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type ButtonInteraction,
  type Message,
} from "discord.js";

interface AfkEntry {
  status: string;
  since: number;
  dmOnMention: boolean;
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
    afkUsers.set(userId, { status, since, dmOnMention: false });
    await message.reply({
      suppressHelpFooter: true,
      embeds: [
        new EmbedBuilder()
          .setColor(0xff0000)
          .setDescription(`✅ <@${userId}>: You're now AFK with the status: **${status}**`)
          .addFields({
            name: "Should I DM you when someone mentions you while AFK?",
            value: "Choose Yes or No below.",
          }),
      ],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`afk:dm:yes:${userId}:${since}`)
            .setLabel("Yes")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`afk:dm:no:${userId}:${since}`)
            .setLabel("No")
            .setStyle(ButtonStyle.Secondary),
        ),
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
      if (entry.dmOnMention) {
        const serverName = message.guild?.name ?? "a server";
        await mentionedUser.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0xff0000)
              .setTitle("You were mentioned while AFK")
              .setDescription(
                `**${message.author.tag}** mentioned you in **${serverName}**.\n[Jump to message](${message.url})`,
              ),
          ],
        }).catch(() => {});
      }
    }
  }
}

export async function handleAfkInteraction(interaction: ButtonInteraction): Promise<void> {
  const match = interaction.customId.match(/^afk:dm:(yes|no):(\d+):(\d+)$/);
  if (!match) return;

  const [, choice, userId, sessionId] = match;
  if (interaction.user.id !== userId) {
    await interaction.reply({ content: "Only the AFK user can choose this.", ephemeral: true });
    return;
  }

  const entry = afkUsers.get(userId);
  if (!entry || String(entry.since) !== sessionId) {
    await interaction.reply({ content: "This AFK prompt has expired.", ephemeral: true });
    return;
  }

  entry.dmOnMention = choice === "yes";
  await interaction.deferUpdate();
  await interaction.message.edit({ components: [] });
  await interaction.followUp({
    content: entry.dmOnMention
      ? "You'll get a DM when someone mentions you while AFK."
      : "AFK mention DMs are turned off.",
    ephemeral: true,
  });
}

export { afkUsers };
