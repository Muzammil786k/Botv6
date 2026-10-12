import { and, eq, sql } from "drizzle-orm";
import type { Message } from "discord.js";
import { botMiningProfilesTable, db } from "@workspace/db";
import { logger } from "../lib/logger";

const CHAT_CREDIT_COOLDOWN_MS = 60_000;
const CHAT_CREDIT_REWARD = 20;
const chatCreditCooldowns = new Map<string, number>();

export async function awardChatCredits(message: Message): Promise<void> {
  if (
    !message.guild ||
    message.author.bot ||
    !message.content.trim() ||
    message.content.trim().startsWith("!")
  ) return;

  const key = `${message.guild.id}:${message.author.id}`;
  const now = Date.now();
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
