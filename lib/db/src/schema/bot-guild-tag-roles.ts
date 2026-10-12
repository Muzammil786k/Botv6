import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const botGuildTagRolesTable = pgTable("bot_guild_tag_roles", {
  guildId: text("guild_id").primaryKey(),
  roleId: text("role_id").notNull(),
  logChannelId: text("log_channel_id").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});