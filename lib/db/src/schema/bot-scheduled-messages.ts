import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const botScheduledMessagesTable = pgTable("bot_scheduled_messages", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  channelId: text("channel_id").notNull(),
  kind: text("kind").notNull(),
  content: text("content").notNull(),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});