import { bigint, boolean, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

export interface VoteRewardEmbedTemplate {
  title?: string;
  description?: string;
  color?: string;
  authorName?: string;
  authorIcon?: string;
  footerText?: string;
  footerIcon?: string;
  thumbnail?: string;
  image?: string;
  successMessage?: string;
  topggUrl?: string;
  discadiaUrl?: string;
}

export const botVoteRewardSettingsTable = pgTable("bot_vote_reward_settings", {
  guildId: text("guild_id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  topggEnabled: boolean("topgg_enabled").notNull().default(false),
  topggSettingsConfigured: boolean("topgg_settings_configured").notNull().default(false),
  discadiaEnabled: boolean("discadia_enabled").notNull().default(false),
  creditsPerVote: integer("credits_per_vote").notNull().default(100),
  topggCreditsPerVote: integer("topgg_credits_per_vote").notNull().default(100),
  discadiaCreditsPerVote: integer("discadia_credits_per_vote").notNull().default(100),
  roleId: text("role_id"),
  topggRoleId: text("topgg_role_id"),
  discadiaRoleId: text("discadia_role_id"),
  roleDurationMs: bigint("role_duration_ms", { mode: "number" }),
  topggRoleDurationMs: bigint("topgg_role_duration_ms", { mode: "number" }),
  discadiaRoleDurationMs: bigint("discadia_role_duration_ms", { mode: "number" }),
  voteEmbedTemplate: jsonb("vote_embed_template").$type<VoteRewardEmbedTemplate>().notNull().default({}),
  topggVoteEmbedTemplate: jsonb("topgg_vote_embed_template").$type<VoteRewardEmbedTemplate>().notNull().default({}),
  discadiaVoteEmbedTemplate: jsonb("discadia_vote_embed_template").$type<VoteRewardEmbedTemplate>().notNull().default({}),
  voteRewardChannelId: text("vote_reward_channel_id"),
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const botTopggVoteEventsTable = pgTable("bot_topgg_vote_events", {
  voteId: text("vote_id").primaryKey(),
  userId: text("user_id").notNull(),
  weight: integer("weight").notNull().default(1),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: bigint("next_attempt_at", { mode: "number" }).notNull().default(0),
  processingAt: timestamp("processing_at", { withTimezone: true }),
  lastError: text("last_error"),
  receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
});

export const botDiscadiaVoteEventsTable = pgTable("bot_discadia_vote_events", {
  voteId: text("vote_id").primaryKey(),
  userId: text("user_id").notNull(),
  guildId: text("guild_id"),
  weight: integer("weight").notNull().default(1),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: bigint("next_attempt_at", { mode: "number" }).notNull().default(0),
  processingAt: timestamp("processing_at", { withTimezone: true }),
  lastError: text("last_error"),
  receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
});

export const botVoteRewardClaimsTable = pgTable(
  "bot_vote_reward_claims",
  {
    voteId: text("vote_id").notNull(),
    platform: text("platform").notNull().default("topgg"),
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    claimStatus: text("claim_status").notNull().default("rewarded"),
    creditsAwarded: integer("credits_awarded").notNull().default(0),
    roleId: text("role_id"),
    roleDurationMs: bigint("role_duration_ms", { mode: "number" }),
    roleExpiresAt: bigint("role_expires_at", { mode: "number" }),
    roleStatus: text("role_status").notNull().default("none"),
    roleAttempts: integer("role_attempts").notNull().default(0),
    roleNextAttemptAt: bigint("role_next_attempt_at", { mode: "number" }).notNull().default(0),
    notificationStatus: text("notification_status").notNull().default("pending"),
    notificationUpdatedAt: timestamp("notification_updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.voteId, table.platform, table.guildId] })],
);