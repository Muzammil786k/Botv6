import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const botQuoteRolesTable = pgTable("bot_quote_roles", {
  guildId: text("guild_id").primaryKey(),
  requiredRoleIds: text("required_role_ids").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});