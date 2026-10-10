import { and, eq, sql } from "drizzle-orm";
import type { Message } from "discord.js";
import { botMiningProfilesTable, db } from "@workspace/db";
import { logger } from "../lib/logger";

const CHAT_CREDIT_COOLDOWN_MS = 60_000;
const CHAT_CREDIT_REWARD = 20;
const WORK_CREDIT_COOLDOWN_MS = 60 * 60_000;
const WORK_CREDIT_REWARD = 20;
const chatCreditCooldowns = new Map<string, number>();

export async function handleWorkCommand(message: Message): Promise<void> {
  const guild = message.guild;
  if (!guild) return;

  const now = Date.now();
  try {
    const result = await db.transaction(async (tx) => {
      await tx.insert(botMiningProfilesTable)
        .values({ guildId: guild.id, userId: message.author.id })
        .onConflictDoNothing();

      const [profile] = await tx.select()
        .from(botMiningProfilesTable)
        .where(and(
          eq(botMiningProfilesTable.guildId, guild.id),
          eq(botMiningProfilesTable.userId, message.author.id),
        ))
        .for("update");
      if (!profile) throw new Error("Could not load player profile for work reward");

      const cooldowns = profile.activityCooldowns ?? {};
      const lastWorkAt = cooldowns["work"] ?? 0;
      const remaining = WORK_CREDIT_COOLDOWN_MS - (now - lastWorkAt);
      if (remaining > 0) return { status: "cooldown" as const, remaining };

      const balance = profile.coins + WORK_CREDIT_REWARD;
      await tx.update(botMiningProfilesTable)
        .set({
          coins: balance,
          activityCooldowns: { ...cooldowns, work: now },
          updatedAt: new Date(now),
        })
        .where(and(
          eq(botMiningProfilesTable.guildId, guild.id),
          eq(botMiningProfilesTable.userId, message.author.id),
        ));
      return { status: "earned" as const, balance };
    });

    if (result.status === "cooldown") {
      const minutes = Math.ceil(result.remaining / 60_000);
      const hours = Math.floor(minutes / 60);
      const remainingMinutes = minutes % 60;
      const wait = hours > 0
        ? `${hours}h${remainingMinutes > 0 ? ` ${remainingMinutes}m` : ""}`
        : `${remainingMinutes}m`;
      await message.reply(`⏳ You can work again in **${wait}**.`);
      return;
    }

    await message.reply(`<a:panda_hardworking:1558485528565784686> Work complete! You earned **${WORK_CREDIT_REWARD} credits**. Balance: **${result.balance.toLocaleString()} credits**.`);
  } catch (error) {
    logger.error({ err: error, guildId: guild.id, userId: message.author.id }, "Failed to award work credits");
    await message.reply("❌ Could not complete work right now. Please try again.");
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
