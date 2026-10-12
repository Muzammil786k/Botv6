import { bigint, boolean, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const botCrateSettingsTable = pgTable("bot_crate_settings", {
  guildId: text("guild_id").primaryKey(),
  channelId: text("channel_id").notNull(),
  intervalMinutes: integer("interval_minutes").notNull().default(30),
  enabled: boolean("enabled").notNull().default(true),
  nextCrateAt: bigint("next_crate_at", { mode: "number" }).notNull().default(0),
  activeMessageId: text("active_message_id"),
  activeCreditReward: integer("active_boost_percent"),
  activeReaction: text("active_reaction"),
  activeExpiresAt: bigint("active_expires_at", { mode: "number" }),
  totalCreditDropsClaimed: integer("total_crates_claimed").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
