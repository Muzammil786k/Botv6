import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type MessageCreateOptions } from "discord.js";
import { eq } from "drizzle-orm";
import {
  botVoteRewardClaimsTable,
  botVoteRewardSettingsTable,
  db,
  type VoteRewardEmbedTemplate,
} from "@workspace/db";
import { logger } from "../lib/logger";

export type VotePlatform = "topgg" | "discadia";
type VoteClaim = typeof botVoteRewardClaimsTable.$inferSelect;

export interface VoteRewardMessageContext {
  user: string;
  username: string;
  credits: number;
  role: string;
  platform: string;
  server: string;
}

const DEFAULT_TEMPLATE: VoteRewardEmbedTemplate = {
  title: "Thanks for voting on {platform}!",
  description: "You received **{credits} credits** in **{server}**.{role}",
  color: "#ff3366",
  successMessage: "Your vote reward is ready, {user}!",
};

const FIELD_LIMITS: Record<keyof VoteRewardEmbedTemplate, number> = {
  title: 256,
  description: 4096,
  color: 7,
  authorName: 256,
  authorIcon: 2048,
  footerText: 2048,
  footerIcon: 2048,
  thumbnail: 2048,
  image: 2048,
  successMessage: 2000,
  topggUrl: 2048,
  discadiaUrl: 2048,
};

const URL_FIELDS = new Set<keyof VoteRewardEmbedTemplate>([
  "authorIcon",
  "footerIcon",
  "thumbnail",
  "image",
  "topggUrl",
  "discadiaUrl",
]);

const EMBED_FIELDS: Record<string, keyof VoteRewardEmbedTemplate> = {
    title: "title",
    description: "description",
    color: "color",
    author: "authorName",
    authoricon: "authorIcon",
    footer: "footerText",
    footericon: "footerIcon",
    thumbnail: "thumbnail",
    image: "image",
    success: "successMessage",
    topggurl: "topggUrl",
    discadiaurl: "discadiaUrl",
};

export function getVoteRewardEmbedFieldKey(field: string): keyof VoteRewardEmbedTemplate | undefined {
  return EMBED_FIELDS[field.toLowerCase()];
}

export function validateVoteRewardEmbedField(
  field: string,
  value: string,
): { key: keyof VoteRewardEmbedTemplate; value: string } | null {
  const key = getVoteRewardEmbedFieldKey(field);
  if (!key || value.length > FIELD_LIMITS[key]) return null;
  if (key === "color" && !/^#[0-9a-f]{6}$/i.test(value)) return null;
  if (URL_FIELDS.has(key) && !isHttpUrl(value)) return null;
  return { key, value };
}

export async function loadVoteRewardEmbedTemplate(
  guildId: string,
  platform: VotePlatform | "shared",
): Promise<VoteRewardEmbedTemplate> {
  const [settings] = await db.select().from(botVoteRewardSettingsTable)
    .where(eq(botVoteRewardSettingsTable.guildId, guildId))
    .limit(1);
  const shared = settings?.voteEmbedTemplate ?? {};
  if (platform === "shared") return { ...shared };
  const platformTemplate = platform === "topgg"
    ? settings?.topggVoteEmbedTemplate
    : settings?.discadiaVoteEmbedTemplate;
  return { ...shared, ...(platformTemplate ?? {}) };
}

export function buildVoteRewardMessage(
  template: VoteRewardEmbedTemplate,
  context: VoteRewardMessageContext,
): MessageCreateOptions {
  const values: Record<string, string> = {
    user: context.user,
    username: context.username,
    credits: String(context.credits),
    role: context.role,
    platform: context.platform,
    server: context.server,
  };
  const render = (value: string | undefined, fallback = "", limit = 6000): string =>
    (value ?? fallback).replace(/\{(user|username|credits|role|platform|server)\}/gi, (_match, key: string) => values[key.toLowerCase()] ?? "").slice(0, limit);
  let remainingEmbedCharacters = 6000;
  const renderEmbedText = (value: string | undefined, fallback: string, limit: number): string => {
    const rendered = render(value, fallback, limit).slice(0, remainingEmbedCharacters);
    remainingEmbedCharacters -= rendered.length;
    return rendered;
  };

  const color = template.color && /^#[0-9a-f]{6}$/i.test(template.color)
    ? Number.parseInt(template.color.slice(1), 16)
    : Number.parseInt(DEFAULT_TEMPLATE.color!.slice(1), 16);
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(renderEmbedText(template.title, DEFAULT_TEMPLATE.title!, 256))
    .setDescription(renderEmbedText(template.description, DEFAULT_TEMPLATE.description!, 4096));

  const authorIcon = safeUrl(template.authorIcon);
  const authorName = renderEmbedText(template.authorName, authorIcon ? context.platform : "", 256);
  if (authorName || authorIcon) embed.setAuthor({ name: authorName || context.platform, ...(authorIcon ? { iconURL: authorIcon } : {}) });
  const footerIcon = safeUrl(template.footerIcon);
  const footerText = renderEmbedText(template.footerText, footerIcon ? "Vote rewards" : "", 2048);
  if (footerText || footerIcon) embed.setFooter({ text: footerText || "Vote rewards", ...(footerIcon ? { iconURL: footerIcon } : {}) });

  const thumbnail = safeUrl(template.thumbnail);
  const image = safeUrl(template.image);
  if (thumbnail) embed.setThumbnail(thumbnail);
  if (image) embed.setImage(image);

  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  const buttons = new ActionRowBuilder<ButtonBuilder>();
  const topggUrl = safeUrl(template.topggUrl);
  const discadiaUrl = safeUrl(template.discadiaUrl);
  if (discadiaUrl) buttons.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Discadia").setURL(discadiaUrl));
  if (topggUrl) buttons.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Top.gg").setURL(topggUrl));
  if (buttons.components.length > 0) components.push(buttons);

  const content = render(template.successMessage, DEFAULT_TEMPLATE.successMessage, 2000);
  return {
    ...(content ? { content } : {}),
    embeds: [embed],
    ...(components.length ? { components } : {}),
    allowedMentions: { parse: [] },
  };
}

export async function sendVoteRewardNotification(
  client: import("discord.js").Client,
  claim: VoteClaim,
  platform: VotePlatform,
): Promise<void> {
  const [settings] = await db.select().from(botVoteRewardSettingsTable)
    .where(eq(botVoteRewardSettingsTable.guildId, claim.guildId))
    .limit(1);
  const template: VoteRewardEmbedTemplate = {
    ...(settings?.voteEmbedTemplate ?? {}),
    ...(platform === "topgg" ? settings?.topggVoteEmbedTemplate : settings?.discadiaVoteEmbedTemplate),
  };
  const user = await client.users.fetch(claim.userId);
  const guild = client.guilds.cache.get(claim.guildId);
  const role = claim.roleId ? guild?.roles.cache.get(claim.roleId) : undefined;
  const roleText = claim.roleId
    ? claim.roleStatus === "assigned" || claim.roleStatus === "already_had"
      ? ` You also received ${role?.toString() ?? `<@&${claim.roleId}>`}.`
      : claim.roleStatus === "pending_add"
        ? " Your role reward is being applied."
        : " Your credits were processed, but the role could not be assigned; please contact a server admin."
    : "";
  const payload = buildVoteRewardMessage(template, {
    user: `<@${user.id}>`,
    username: user.username,
    credits: claim.creditsAwarded,
    role: roleText,
    platform: platform === "topgg" ? "Top.gg" : "Discadia",
    server: guild?.name ?? "your server",
  });

  if (settings?.voteRewardChannelId) {
    try {
      const channel = await guild?.channels.fetch(settings.voteRewardChannelId);
      if (!channel?.isTextBased() || !channel.isSendable()) throw new Error("Configured vote reward channel is unavailable or cannot receive messages");
      await channel.send(payload);
      return;
    } catch (error) {
      logger.warn({ err: error, guildId: claim.guildId, channelId: settings.voteRewardChannelId }, "Vote reward channel unavailable; falling back to voter DM");
    }
  }

  await user.send(payload);
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function safeUrl(value: string | undefined): string | undefined {
  return value && isHttpUrl(value) ? value : undefined;
}