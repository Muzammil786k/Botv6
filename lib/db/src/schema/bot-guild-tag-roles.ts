import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const botGuildTagRolesTable = pgTable("bot_guild_tag_roles", {
  guildId: text("guild_id").primaryKey(),
  roleId: text("role_id").notNull(),
  logChannelId: text("log_channel_id").notNull(),
  embedTitle: text("embed_title"),
  embedDescription: text("embed_description"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});