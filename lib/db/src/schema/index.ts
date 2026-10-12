// Export your models here. Add one export per file
// export * from "./posts";
//
// Each model/table should ideally be split into different files.
// Each model/table should define a Drizzle table, insert schema, and types:
//
//   import { pgTable, text, serial } from "drizzle-orm/pg-core";
//   import { createInsertSchema } from "drizzle-zod";
//   import { z } from "zod/v4";
//
//   export const postsTable = pgTable("posts", {
//     id: serial("id").primaryKey(),
//     title: text("title").notNull(),
//   });
//
//   export const insertPostSchema = createInsertSchema(postsTable).omit({ id: true });
//   export type InsertPost = z.infer<typeof insertPostSchema>;
//   export type Post = typeof postsTable.$inferSelect;

export * from "./bot-automations";
export * from "./bot-mining";
export * from "./bot-social-roles";
export * from "./bot-moderation-roles";
export * from "./bot-game-settings";
export * from "./bot-jtc-temp-channels";
export * from "./bot-quote-settings";
export * from "./bot-experience";
export * from "./bot-experience-settings";
export * from "./bot-level-roles";
export * from "./bot-vote-settings";
export * from "./bot-vote-boosts";
export * from "./bot-experience-preferences";
export * from "./bot-crate-settings";
export * from "./bot-credit-airdrops";
export * from "./bot-experience-boosts";
export * from "./bot-tickets";
export * from "./bot-role-shop";
export * from "./bot-custom-embeds";
export * from "./bot-status-roles";
export * from "./bot-guild-tag-roles";