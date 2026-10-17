import { and, eq, sql } from "drizzle-orm";
import { EmbedBuilder } from "discord.js";
import type { Message } from "discord.js";
import { botMiningProfilesTable, db } from "@workspace/db";
import { logger } from "../lib/logger";

const CHAT_CREDIT_COOLDOWN_MS = 60_000;
const CHAT_CREDIT_REWARD = 20;
const ACTIVE_CHAT_WINDOW_MS = 10 * 60_000;
const RANDOM_REWARD_INTERVAL_MS = 30 * 60_000;
const RANDOM_REWARD_TIERS = [
  { name: "Common", icon: "<:common:1558505660470010070>", credits: 50, weight: 750, color: 0x95a5a6 },
  { name: "Rare", icon: "🔷", credits: 100, weight: 249, color: 0x3498db },
  { name: "Epic", icon: "🔷", credits: 200, weight: 1, color: 0xf1c40f },
] as const;
const chatCreditCooldowns = new Map<string, number>();
const activeChatters = new Map<string, Map<string, { messageTimes: number[]; displayName: string }>>();
const lastRandomRewardAt = new Map<string, number>();
const randomRewardInProgress = new Set<string>();

async function maybeAwardRandomChatReward(message: Message, now: number): Promise<void> {
  const guild = message.guild;
  if (!guild || randomRewardInProgress.has(guild.id)) return;
  if (now - (lastRandomRewardAt.get(guild.id) ?? 0) < RANDOM_REWARD_INTERVAL_MS) return;

  const chatterMap = activeChatters.get(guild.id);
  if (!chatterMap) return;
  const eligibleChatters = [...chatterMap.entries()]
    .map(([userId, chatter]) => [
      userId,
      chatter,
      chatter.messageTimes.filter((time) => now - time < ACTIVE_CHAT_WINDOW_MS).length,
    ] as const)
    .filter(([, , messageCount]) => messageCount > 20);
  if (eligibleChatters.length < 2) return;

  randomRewardInProgress.add(guild.id);
  try {
    const candidates = [...eligibleChatters];
    const winners: (typeof eligibleChatters)[number][] = [];
    for (let winnerIndex = 0; winnerIndex < 2; winnerIndex++) {
      const totalActivity = candidates.reduce((total, [, , messageCount]) => total + messageCount, 0);
      let activityPick = Math.random() * totalActivity;
      const candidateIndex = candidates.findIndex(([, , messageCount]) => {
        activityPick -= messageCount;
        return activityPick < 0;
      });
      winners.push(candidates.splice(candidateIndex, 1)[0]!);
    }
    const selectedTiers: (typeof RANDOM_REWARD_TIERS)[number][] = [];
    for (let tierIndex = 0; tierIndex < 2; tierIndex++) {
      const availableTiers = RANDOM_REWARD_TIERS.filter((tier) => !selectedTiers.includes(tier));
      let tierPick = Math.random() * availableTiers.reduce((total, tier) => total + tier.weight, 0);
      selectedTiers.push(availableTiers.find((tier) => {
        tierPick -= tier.weight;
        return tierPick < 0;
      })!);
    }
    const rewards = winners.map(([userId, chatter], index) => ({
      userId,
      chatter,
      reward: selectedTiers[index]!,
    }));
    await db.transaction(async (tx) => {
      for (const { userId, reward } of rewards) {
        await tx.insert(botMiningProfilesTable)
          .values({ guildId: guild.id, userId, coins: reward.credits })
          .onConflictDoUpdate({
            target: [botMiningProfilesTable.guildId, botMiningProfilesTable.userId],
            set: {
              coins: sql<number>`${botMiningProfilesTable.coins} + ${reward.credits}`,
              updatedAt: new Date(now),
            },
          });
      }
    });
    lastRandomRewardAt.set(guild.id, now);

    const winnerLabel = `${rewards[0]!.chatter.displayName} and ${rewards[1]!.chatter.displayName}`;
    const embedColor = rewards[0]!.reward.credits > rewards[1]!.reward.credits
      ? rewards[0]!.reward.color
      : rewards[1]!.reward.color;
    const rewardLines = rewards.map(({ chatter, reward }) =>
      `**${chatter.displayName}** won a ${reward.icon} **${reward.name} Reward** – <:credits:1558505663531851933> **__${reward.credits} Credits__**`,
    );
    await message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(embedColor)
          .setTitle(`Congratulations ${winnerLabel}!`)
          .setDescription(`${rewardLines.join("\n")}\nFor being active in chat.`)
          .setTimestamp(now),
      ],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    logger.error({ err: error, guildId: guild.id }, "Could not award random active chatter reward");
  } finally {
    randomRewardInProgress.delete(guild.id);
  }
}

export async function awardChatCredits(message: Message): Promise<void> {
  if (
    !message.guild ||
    message.author.bot ||
    !message.content.trim() ||
    message.content.trim().startsWith("!")
  ) return;

  const key = `${message.guild.id}:${message.author.id}`;
  const now = Date.now();
  let guildChatters = activeChatters.get(message.guild.id);
  if (!guildChatters) {
    guildChatters = new Map();
    activeChatters.set(message.guild.id, guildChatters);
  }
  const chatter = guildChatters.get(message.author.id) ?? { messageTimes: [], displayName: message.author.displayName };
  chatter.messageTimes = chatter.messageTimes.filter((time) => now - time < ACTIVE_CHAT_WINDOW_MS);
  chatter.messageTimes.push(now);
  chatter.displayName = message.member?.displayName ?? message.author.displayName;
  guildChatters.set(message.author.id, chatter);
  for (const [userId, chatter] of guildChatters) {
    if (chatter.messageTimes.length === 0) guildChatters.delete(userId);
  }

  await maybeAwardRandomChatReward(message, now);
  if (now - (chatCreditCooldowns.get(key) ?? 0) < CHAT_CREDIT_COOLDOWN_MS) return;

  try {
    await db.insert(botMiningProfilesTable)
      .values({ guildId: message.guild.id, userId: message.author.id, coins: CHAT_CREDIT_REWARD })
      .onConflictDoUpdate({
        target: [botMiningProfilesTable.guildId, botMiningProfilesTable.userId],
        set: {
          coins: sql<number>`${botMiningProfilesTable.coins} + ${CHAT_CREDIT_REWARD}`,
          updatedAt: new Date(now),
        },
      });
    chatCreditCooldowns.set(key, now);
  } catch (error) {
    logger.error(
      { err: error, guildId: message.guild.id, userId: message.author.id },
      "Failed to award chat credits",
    );
  }
}
