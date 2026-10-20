import { and, eq } from "drizzle-orm";
import { EmbedBuilder, PermissionFlagsBits, type Message } from "discord.js";
import { botModerationActionLimitsTable, db } from "@workspace/db";

const MAX_ACTION_LIMIT = 100_000;
const EMBED_COLOR = 0x2b2d31;

export type LimitedModerationAction = "kick" | "ban";

interface ModerationQuotaResult {
  allowed: boolean;
  reserved: boolean;
  limit: number | null;
  remaining: number | null;
}

export async function reserveModerationAction(
  guildId: string,
  userId: string,
  action: LimitedModerationAction,
): Promise<ModerationQuotaResult> {
  return db.transaction(async (tx) => {
    const [setting] = await tx.select().from(botModerationActionLimitsTable)
      .where(and(
        eq(botModerationActionLimitsTable.guildId, guildId),
        eq(botModerationActionLimitsTable.userId, userId),
      ))
      .for("update");
    const limit = action === "kick" ? setting?.kickLimit ?? null : setting?.banLimit ?? null;
    if (limit === null) return { allowed: true, reserved: false, limit: null, remaining: null };

    const used = action === "kick" ? setting!.kickUsed : setting!.banUsed;
    if (used >= limit) return { allowed: false, reserved: false, limit, remaining: 0 };

    const updatedAt = new Date();
    if (action === "kick") {
      await tx.update(botModerationActionLimitsTable)
        .set({ kickUsed: used + 1, updatedAt })
        .where(and(
          eq(botModerationActionLimitsTable.guildId, guildId),
          eq(botModerationActionLimitsTable.userId, userId),
        ));
    } else {
      await tx.update(botModerationActionLimitsTable)
        .set({ banUsed: used + 1, updatedAt })
        .where(and(
          eq(botModerationActionLimitsTable.guildId, guildId),
          eq(botModerationActionLimitsTable.userId, userId),
        ));
    }
    return { allowed: true, reserved: true, limit, remaining: limit - used - 1 };
  });
}

export async function releaseModerationAction(
  guildId: string,
  userId: string,
  action: LimitedModerationAction,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [setting] = await tx.select().from(botModerationActionLimitsTable)
      .where(and(
        eq(botModerationActionLimitsTable.guildId, guildId),
        eq(botModerationActionLimitsTable.userId, userId),
      ))
      .for("update");
    if (!setting) return;

    if (action === "kick") {
      await tx.update(botModerationActionLimitsTable)
        .set({ kickUsed: Math.max(0, setting.kickUsed - 1), updatedAt: new Date() })
        .where(and(
          eq(botModerationActionLimitsTable.guildId, guildId),
          eq(botModerationActionLimitsTable.userId, userId),
        ));
    } else {
      await tx.update(botModerationActionLimitsTable)
        .set({ banUsed: Math.max(0, setting.banUsed - 1), updatedAt: new Date() })
        .where(and(
          eq(botModerationActionLimitsTable.guildId, guildId),
          eq(botModerationActionLimitsTable.userId, userId),
        ));
    }
  });
}

function parseUserId(message: Message, value: string | undefined): string | null {
  return message.mentions.users.first()?.id ?? /^<@!?(\d{17,20})>$/.exec(value ?? "")?.[1] ??
    (/^\d{17,20}$/.test(value ?? "") ? value! : null);
}

function reply(message: Message, title: string, description: string): Promise<unknown> {
  return message.reply({ embeds: [new EmbedBuilder().setColor(EMBED_COLOR).setTitle(title).setDescription(description)] });
}

export async function handleModerationLimitCommand(message: Message, args: string[]): Promise<void> {
  const guild = message.guild;
  if (!guild) return;
  const member = message.member ?? await guild.members.fetch(message.author.id).catch(() => null);
  if (!member?.permissions.has(PermissionFlagsBits.ManageGuild) && !member?.permissions.has(PermissionFlagsBits.Administrator)) {
    await reply(message, "Moderation limits", "❌ You need **Manage Server** permission to configure action limits.");
    return;
  }

  const action = args[0]?.toLowerCase() ?? "help";
  const userId = parseUserId(message, args[1]);
  if ((action === "set" || action === "status" || action === "reset" || action === "remove") && !userId) {
    await reply(message, "Moderation limits", "Usage: `!modlimit set @user kick <count> ban <count>`, `!modlimit status @user`, `!modlimit reset @user [kick|ban]`, or `!modlimit remove @user`.");
    return;
  }

  if (action === "set") {
    const values = args.slice(2);
    const changes: Partial<Record<LimitedModerationAction, number>> = {};
    for (let index = 0; index < values.length;) {
      const kind = values[index]?.toLowerCase();
      const value = values[index + 1];
      if ((kind !== "kick" && kind !== "ban") || !/^\d+$/.test(value ?? "")) {
        await reply(message, "Moderation limits", "Use `!modlimit set @user kick <count> ban <count>`. Counts can be from 0 to 100,000.");
        return;
      }
      const count = Number(value);
      if (!Number.isSafeInteger(count) || count > MAX_ACTION_LIMIT) {
        await reply(message, "Moderation limits", `Each limit must be from 0 to ${MAX_ACTION_LIMIT.toLocaleString()}.`);
        return;
      }
      changes[kind] = count;
      index += 2;
    }
    if (Object.keys(changes).length === 0) {
      await reply(message, "Moderation limits", "Set at least one limit: `!modlimit set @user kick <count> ban <count>`.");
      return;
    }

    const [existing] = await db.select().from(botModerationActionLimitsTable)
      .where(and(
        eq(botModerationActionLimitsTable.guildId, guild.id),
        eq(botModerationActionLimitsTable.userId, userId!),
      ))
      .limit(1);
    const kickLimit = changes.kick ?? existing?.kickLimit ?? null;
    const banLimit = changes.ban ?? existing?.banLimit ?? null;
    await db.insert(botModerationActionLimitsTable)
      .values({
        guildId: guild.id,
        userId: userId!,
        kickLimit,
        kickUsed: existing?.kickUsed ?? 0,
        banLimit,
        banUsed: existing?.banUsed ?? 0,
      })
      .onConflictDoUpdate({
        target: [botModerationActionLimitsTable.guildId, botModerationActionLimitsTable.userId],
        set: { kickLimit, banLimit, updatedAt: new Date() },
      });
    await reply(message, "Moderation limits updated", `Limits set for <@${userId}>. Usage is cumulative until an admin resets it.`);
    return;
  }

  if (action === "status") {
    const [setting] = await db.select().from(botModerationActionLimitsTable)
      .where(and(
        eq(botModerationActionLimitsTable.guildId, guild.id),
        eq(botModerationActionLimitsTable.userId, userId!),
      ))
      .limit(1);
    if (!setting) {
      await reply(message, "Moderation limits", `<@${userId}> has no kick or ban limits configured.`);
      return;
    }
    const describe = (label: string, limit: number | null, used: number) =>
      limit === null ? `${label}: unlimited` : `${label}: ${Math.max(0, limit - used)} remaining of ${limit} (${used} used)`;
    await reply(message, "Moderation limit status", `<@${userId}>\n${describe("Kicks", setting.kickLimit, setting.kickUsed)}\n${describe("Bans", setting.banLimit, setting.banUsed)}`);
    return;
  }

  if (action === "reset") {
    const kind = args[2]?.toLowerCase();
    if (kind && kind !== "kick" && kind !== "ban") {
      await reply(message, "Moderation limits", "Choose `kick` or `ban`: `!modlimit reset @user [kick|ban]`.");
      return;
    }
    const values = kind === "kick"
      ? { kickUsed: 0, updatedAt: new Date() }
      : kind === "ban"
        ? { banUsed: 0, updatedAt: new Date() }
        : { kickUsed: 0, banUsed: 0, updatedAt: new Date() };
    const updated = await db.update(botModerationActionLimitsTable)
      .set(values)
      .where(and(
        eq(botModerationActionLimitsTable.guildId, guild.id),
        eq(botModerationActionLimitsTable.userId, userId!),
      ))
      .returning({ userId: botModerationActionLimitsTable.userId });
    await reply(message, "Moderation limits", updated.length
      ? `Usage reset for <@${userId}>.`
      : `No limits are configured for <@${userId}>.`);
    return;
  }

  if (action === "remove" || action === "clear") {
    const removed = await db.delete(botModerationActionLimitsTable)
      .where(and(
        eq(botModerationActionLimitsTable.guildId, guild.id),
        eq(botModerationActionLimitsTable.userId, userId!),
      ))
      .returning({ userId: botModerationActionLimitsTable.userId });
    await reply(message, "Moderation limits", removed.length
      ? `Kick and ban limits removed for <@${userId}>.`
      : `No limits are configured for <@${userId}>.`);
    return;
  }

  await reply(message, "Moderation limits", "Usage: `!modlimit set @user kick <count> ban <count>`, `!modlimit status @user`, `!modlimit reset @user [kick|ban]`, or `!modlimit remove @user`.");
}