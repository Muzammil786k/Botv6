import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const botBumpSettingsTable = pgTable("bot_bump_settings", {
  guildId: text("guild_id").primaryKey(),
  roleIds: jsonb("role_ids").$type<string[]>().notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
