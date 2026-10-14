import {
  EmbedBuilder,
  type TextChannel,
  type Client,
  type MessageEditOptions,
} from "discord.js";
import { premiumColors, premiumMessagePayload } from "./presentation";

export interface Giveaway {
  messageId: string;
  channelId: string;
  guildId: string;
  prize: string;
  endsAt: number;
  hostId: string;
  participants: Set<string>;
  ended: boolean;
  winners: string[];
  winnerCount: number;
  timer?: ReturnType<typeof setTimeout>;
}

const giveaways = new Map<string, Giveaway>();

function parseDuration(input: string): number | null {
  const match = input.match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return null;
  const value = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return value * multipliers[unit];
}

function formatTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} second${s !== 1 ? "s" : ""}`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m !== 1 ? "s" : ""}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h !== 1 ? "s" : ""}`;
  const d = Math.floor(h / 24);
  return `${d} day${d !== 1 ? "s" : ""}`;
}

function buildGiveawayEmbed(giveaway: Giveaway): EmbedBuilder {
  const remaining = giveaway.endsAt - Date.now();
  const endsAt = Math.floor(giveaway.endsAt / 1000);

  if (giveaway.ended) {
    const winnersLine =
      giveaway.winners.length > 0
        ? `**Winners: ${giveaway.winners.map((id) => `<@${id}>`).join(", ")}**`
        : "**Winners: None**";

    return new EmbedBuilder()
      .setTitle(giveaway.prize)
      .setColor(premiumColors.brand)
      .setDescription(
        `Ended <t:${endsAt}:R>\nHosted by <@${giveaway.hostId}>\nParticipants: ${giveaway.participants.size}\n${winnersLine}`
      )
      .setTimestamp(giveaway.endsAt);
  }

  const timeLeft = remaining > 0 ? formatTime(remaining) : "Ending soon";

  return new EmbedBuilder()
    .setTitle(giveaway.prize)
    .setColor(premiumColors.brand)
    .setDescription(
      `End in ${timeLeft}\nHosted by <@${giveaway.hostId}>\nParticipants: ${giveaway.participants.size}`
    )
    .setTimestamp(giveaway.endsAt);
}

export async function pickWinners(giveaway: Giveaway): Promise<string[]> {
  const pool = [...giveaway.participants];
  if (pool.length === 0) return [];
  const winners: string[] = [];
  const available = [...pool];
  const count = Math.min(giveaway.winnerCount, available.length);
  for (let i = 0; i < count; i++) {
    const idx = Math.floor(Math.random() * available.length);
    winners.push(available.splice(idx, 1)[0]);
  }
  return winners;
}

export async function endGiveaway(client: Client, messageId: string): Promise<{ success: boolean; message: string }> {
  const giveaway = giveaways.get(messageId);
  if (!giveaway) return { success: false, message: "Giveaway not found." };
  if (giveaway.ended) return { success: false, message: "Giveaway already ended." };

  if (giveaway.timer) clearTimeout(giveaway.timer);
  giveaway.ended = true;
  giveaway.winners = await pickWinners(giveaway);

  try {
    const guild = await client.guilds.fetch(giveaway.guildId);
    const channel = (await guild.channels.fetch(giveaway.channelId)) as TextChannel;
    const message = await channel.messages.fetch(giveaway.messageId);

    await message.edit(premiumMessagePayload({
      content: "🎉 **GIVEAWAY ENDED** 🎉",
      embeds: [buildGiveawayEmbed(giveaway)],
      components: [],
    }, client.user) as MessageEditOptions);

    if (giveaway.winners.length > 0) {
      await channel.send(premiumMessagePayload({
        content: `🎉 Congratulations ${giveaway.winners.map((id) => `<@${id}>`).join(", ")}! You won **${giveaway.prize}**!`,
        allowedMentions: { users: giveaway.winners },
      }, client.user));
    } else {
      await channel.send(premiumMessagePayload(
        `No one entered the giveaway for **${giveaway.prize}**.`,
        client.user,
      ));
    }
  } catch (e) {
    console.error("Error ending giveaway:", e);
  }

  return { success: true, message: `Giveaway ended. Winners: ${giveaway.winners.map((id) => `<@${id}>`).join(", ") || "None"}` };
}

export async function rerollGiveaway(client: Client, messageId: string, winnerOverride?: number): Promise<{ success: boolean; message: string }> {
  const giveaway = giveaways.get(messageId);
  if (!giveaway) return { success: false, message: "Giveaway not found." };
  if (!giveaway.ended) return { success: false, message: "Giveaway has not ended yet." };

  const originalCount = giveaway.winnerCount;
  if (winnerOverride !== undefined) giveaway.winnerCount = winnerOverride;
  giveaway.winners = await pickWinners(giveaway);
  giveaway.winnerCount = originalCount;

  try {
    const guild = await client.guilds.fetch(giveaway.guildId);
    const channel = (await guild.channels.fetch(giveaway.channelId)) as TextChannel;

    if (giveaway.winners.length > 0) {
      await channel.send(premiumMessagePayload({
        content: `🎉 Congratulations ${giveaway.winners.map((id) => `<@${id}>`).join(", ")}! You won **${giveaway.prize}**!`,
        allowedMentions: { users: giveaway.winners },
      }, client.user));
    } else {
      await channel.send(premiumMessagePayload("No valid participants to reroll.", client.user));
    }
  } catch (e) {
    console.error("Error rerolling:", e);
  }

  return { success: true, message: `Rerolled. New winners: ${giveaway.winners.map((id) => `<@${id}>`).join(", ") || "None"}` };
}

export async function startGiveaway(
  client: Client,
  channel: TextChannel,
  hostId: string,
  guildId: string,
  durationMs: number,
  prize: string,
  winnerCount = 1
): Promise<{ success: boolean; message: string; messageId?: string }> {
  const endsAt = Date.now() + durationMs;

  const giveaway: Giveaway = {
    messageId: "",
    channelId: channel.id,
    guildId,
    prize,
    endsAt,
    hostId,
    participants: new Set(),
    ended: false,
    winners: [],
    winnerCount,
  };

  const embed = buildGiveawayEmbed(giveaway);

  const message = await channel.send(premiumMessagePayload({
    content: "🎉 **GIVEAWAY** 🎉",
    embeds: [embed],
    components: [],
  }, client.user));

  await message.react("🎉");

  giveaway.messageId = message.id;
  giveaways.set(message.id, giveaway);

  giveaway.timer = setTimeout(() => endGiveaway(client, message.id), durationMs);

  return { success: true, message: "Giveaway started!", messageId: message.id };
}

export { giveaways, parseDuration, buildGiveawayEmbed };
