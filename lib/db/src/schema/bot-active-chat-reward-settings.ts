import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const botActiveChatRewardSettingsTable = pgTable("bot_active_chat_reward_settings", {
  guildId: text("guild_id").primaryKey(),
  channelId: text("channel_id").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});