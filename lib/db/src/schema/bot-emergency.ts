import { boolean, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

export const botEmergencySettingsTable = pgTable("bot_emergency_settings", {
  guildId: text("guild_id").primaryKey(),
  enabled: boolean("enabled").default(false).notNull(),
  emergencyActive: boolean("emergency_active").default(false).notNull(),
  logChannelId: text("log_channel_id").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const botEmergencyQuarantinesTable = pgTable(
  "bot_emergency_quarantines",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    roleIds: jsonb("role_ids").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.userId] })],
);

export const botEmergencyRolePermissionsTable = pgTable(
  "bot_emergency_role_permissions",
  {
    guildId: text("guild_id").notNull(),
    roleId: text("role_id").notNull(),
    permissions: text("permissions").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.roleId] })],
);