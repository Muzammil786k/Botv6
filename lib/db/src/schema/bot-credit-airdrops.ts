import { bigint, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const botCreditAirdropsTable = pgTable("bot_credit_airdrops", {
  guildId: text("guild_id").primaryKey(),
  channelId: text("channel_id").notNull(),
  messageId: text("message_id").notNull(),
  totalCredits: integer("total_credits").notNull(),
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
  entrants: jsonb("entrants").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});