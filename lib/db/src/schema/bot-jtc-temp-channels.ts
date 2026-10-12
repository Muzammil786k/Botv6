import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const botJtcTempChannelsTable = pgTable("bot_jtc_temp_channels", {
  channelId: text("channel_id").primaryKey(),
  guildId: text("guild_id").notNull(),
  ownerId: text("owner_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});