import { jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

export interface CustomEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export const botEmbedOverridesTable = pgTable(
  "bot_embed_overrides",
  {
    guildId: text("guild_id").notNull(),
    commandKey: text("command_key").notNull(),
    title: text("title"),
    description: text("description"),
    color: text("color"),
    authorText: text("author_text"),
    imageUrl: text("image_url"),
    thumbnailUrl: text("thumbnail_url"),
    footerText: text("footer_text"),
    fields: jsonb("fields").$type<CustomEmbedField[] | null>(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.commandKey] })],
);

export const botCustomEmbedsTable = pgTable(
  "bot_custom_embeds",
  {
    guildId: text("guild_id").notNull(),
    name: text("name").notNull(),
    title: text("title"),
    description: text("description"),
    color: text("color"),
    authorText: text("author_text"),
    imageUrl: text("image_url"),
    thumbnailUrl: text("thumbnail_url"),
    footerText: text("footer_text"),
    fields: jsonb("fields").$type<CustomEmbedField[]>().notNull().default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.name] })],
);
