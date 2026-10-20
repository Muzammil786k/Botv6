import { integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

export const botModerationActionLimitsTable = pgTable(
  "bot_moderation_action_limits",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    kickLimit: integer("kick_limit"),
    kickUsed: integer("kick_used").notNull().default(0),
    banLimit: integer("ban_limit"),
    banUsed: integer("ban_used").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.userId] })],
);