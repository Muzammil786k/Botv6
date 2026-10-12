import { EmbedBuilder, type Message } from "discord.js";
import { canUseModerationCommands } from "./moderationRole";

function parseDuration(input: string): number | null {
  const match = input.match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return null;
  const value = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return value * multipliers[unit];
}

export async function handleMute(message: Message): Promise<void> {
  if (!message.guild) return;
  if (!(await canUseModerationCommands(message))) return;

  const args = message.content.trim().split(/\s+/).slice(1);
  if (args.length < 2) {
    await message.reply({
      embeds: [
        new EmbedBuilder().setColor(0xff0000).setTitle("Command: !mute")
          .setDescription("**Usage:** `!mute @user <duration> [reason]`\n**Example:** `!mute @Fluxty 1d spamming`\n**Durations:** `30s` `5m` `2h` `1d`"),
      ],
    });
    return;
  }

  const target = message.mentions.members?.first() ?? message.guild.members.cache.get(args[0]);
  if (!target) {
    await message.reply({ embeds: [new EmbedBuilder().setColor(0xff0000).setDescription("❌ Could not find that member.")] });
    return;
  }
  if (target.user.bot) {
    await message.reply({ embeds: [new EmbedBuilder().setColor(0xff0000).setDescription("❌ You cannot mute a bot.")] });
    return;
  }
  if (target.id === message.author.id) {
    await message.reply({ embeds: [new EmbedBuilder().setColor(0xff0000).setDescription("❌ You cannot mute yourself.")] });
    return;
  }

  const durationArg = args[message.mentions.users.size > 0 ? 1 : 1];
  const duration = parseDuration(durationArg);
  if (!duration) {
    await message.reply({ embeds: [new EmbedBuilder().setColor(0xff0000).setDescription("❌ Invalid duration. Use formats like `30s`, `5m`, `2h`, `1d`.")] });
    return;
  }

  const MAX_TIMEOUT = 28 * 24 * 60 * 60 * 1000;
  if (duration > MAX_TIMEOUT) {
    await message.reply({ embeds: [new EmbedBuilder().setColor(0xff0000).setDescription("❌ Maximum mute duration is **28 days**.")] });
    return;
  }

  if (target.isCommunicationDisabled()) {
    await message.reply({ embeds: [new EmbedBuilder().setColor(0xff0000).setDescription("❌ That user is already muted.")] });
    return;
  }

  const reason = args.slice(message.mentions.users.size > 0 ? 2 : 2).join(" ") || "No reason provided";
  const durationLabel = durationArg.toUpperCase();

  try {
    await target.timeout(duration, reason);
  } catch {
    await message.reply({ embeds: [new EmbedBuilder().setColor(0xff0000).setDescription("❌ Failed to mute that member. Make sure I have the right permissions and my role is above theirs.")] });
    return;
  }

  await message.reply({
    embeds: [new EmbedBuilder().setColor(0x57f287).setDescription(`✅ **${target.user.username}** muted for **${durationLabel}**.\n**Reason:** ${reason}`)],
  });
}

export async function handleUnmute(message: Message): Promise<void> {
  if (!message.guild) return;
  if (!(await canUseModerationCommands(message))) return;

  const args = message.content.trim().split(/\s+/).slice(1);
  const target = message.mentions.members?.first() ?? (args[0] ? message.guild.members.cache.get(args[0]) : null);
  if (!target) {
    await message.reply({ embeds: [new EmbedBuilder().setColor(0xff0000).setDescription("❌ Could not find that member. Usage: `!unmute @user`")] });
    return;
  }

  try {
    await target.timeout(null);
  } catch {
    await message.reply({ embeds: [new EmbedBuilder().setColor(0xff0000).setDescription("❌ Failed to unmute that member.")] });
    return;
  }

  await message.reply({
    embeds: [new EmbedBuilder().setColor(0xff0000).setDescription(`✅ **${target.user.username}** has been unmuted.`)],
  });
}
