import { pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

export const botChannelAutomationsTable = pgTable(
  "bot_channel_automations",
  {
    guildId: text("guild_id").notNull(),
    channelId: text("channel_id").notNull(),
    autoReactEmoji: text("auto_react_emoji"),
    autoResponseTrigger: text("auto_response_trigger"),
    autoResponseContent: text("auto_response_content"),
    stickyContent: text("sticky_content"),
    stickyMessageId: text("sticky_message_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.channelId] }),
  ],
);

export const botJoinToCreateTable = pgTable("bot_join_to_create", {
  guildId: text("guild_id").primaryKey(),
  lobbyChannelId: text("lobby_channel_id").notNull(),
  categoryId: text("category_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const botGuildMessagesTable = pgTable("bot_guild_messages", {
  guildId: text("guild_id").primaryKey(),
  welcomeChannelId: text("welcome_channel_id"),
  welcomeTemplate: text("welcome_template"),
  goodbyeChannelId: text("goodbye_channel_id"),
  goodbyeTemplate: text("goodbye_template"),
  boostChannelId: text("boost_channel_id"),
  boostTitle: text("boost_title"),
  boostTemplate: text("boost_template"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
