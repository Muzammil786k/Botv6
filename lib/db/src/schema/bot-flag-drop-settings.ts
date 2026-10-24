import { bigint, boolean, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

export const botFlagDropSettingsTable = pgTable(
  "bot_flag_drop_settings",
  {
    guildId: text("guild_id").notNull(),
    channelId: text("channel_id").notNull(),
    intervalMinutes: integer("interval_minutes").notNull().default(30),
    enabled: boolean("enabled").notNull().default(true),
    nextDropAt: bigint("next_drop_at", { mode: "number" }).notNull().default(0),
    activeMessageId: text("active_message_id"),
    activeCountryCode: text("active_country_code"),
    activeCreditReward: integer("active_credit_reward"),
    activeCreditRarity: text("active_credit_rarity"),
    activeExpiresAt: bigint("active_expires_at", { mode: "number" }),
    totalWinners: integer("total_winners").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.channelId] })],
);