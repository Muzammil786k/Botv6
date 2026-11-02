import { bigint, boolean, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

export const botGameSettingsTable = pgTable(
  "bot_game_settings",
  {
    guildId: text("guild_id").notNull(),
    gameType: text("game_type").notNull(),
    channelId: text("channel_id").notNull(),
    intervalMinutes: integer("interval_minutes").notNull().default(30),
    reward: integer("reward").notNull().default(100),
    enabled: boolean("enabled").notNull().default(false),
    nextGameAt: bigint("next_game_at", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.gameType] })],
);