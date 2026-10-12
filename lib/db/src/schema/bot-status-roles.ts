import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const botStatusRolesTable = pgTable("bot_status_roles", {
  guildId: text("guild_id").primaryKey(),
  roleId: text("role_id").notNull(),
  logChannelId: text("log_channel_id").notNull(),
  triggerTexts: jsonb("trigger_texts").$type<string[]>().notNull().default([]),
  embedTitle: text("embed_title"),
  embedDescription: text("embed_description"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});