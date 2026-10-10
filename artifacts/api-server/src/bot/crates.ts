import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  type Client,
  type Message,
  type MessageReaction,
  type User,
} from "discord.js";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import {
  botCrateSettingsTable,
  botMiningProfilesTable,
  db,
} from "@workspace/db";
import { logger } from "../lib/logger";

const DEFAULT_INTERVAL_MINUTES = 30;
const MIN_INTERVAL_MINUTES = 30;
const MAX_INTERVAL_MINUTES = 24 * 60;
const CRATE_LIFETIME_MS = 10 * 60_000;
const SCHEDULER_INTERVAL_MS = 30_000;
const REACTION = "🌦️";
const CREDIT_REWARD = 30;

let scheduler: NodeJS.Timeout | undefined;
let schedulerRunning = false;

function creditDropEmbed(expiresAt: number): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle("Credit Drop!")
    .setDescription(
      `<:click:1558393065616707674> **React** to this message with the emoji below to win!\n\n` +
      `<:reaction:1558393068254666785>  **Reaction:** ${REACTION}\n` +
      "<:trophy:1558393071224365102>  **First valid reaction wins!**\n\n" +
      "<:epic:1558393073204076607> **Rarity:** Epic\n" +
      `<:reward:1558393075829702726> **Reward:** ${CREDIT_REWARD} Credits\n` +
      `<:time:1558393079851917372> **Expires:** <t:${Math.floor(expiresAt / 1000)}:R>`,
    );
}

function parseInterval(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^(\d+)(m|h)$/i.exec(value);
  if (!match) return null;
  const amount = Number(match[1]);
  const minutes = amount * (match[2]!.toLowerCase() === "h" ? 60 : 1);
  return Number.isInteger(minutes) &&
    minutes >= MIN_INTERVAL_MINUTES &&
    minutes <= MAX_INTERVAL_MINUTES
    ? minutes
    : null;
}

async function getCreditDropSettings(guildId: string) {
  const [settings] = await db
    .select()
    .from(botCrateSettingsTable)
    .where(eq(botCrateSettingsTable.guildId, guildId));
  return settings;
}

export async function handleCreditDropCommand(message: Message): Promise<void> {
  const guild = message.guild;
  if (!guild) return;
  const member =
    message.member ?? (await guild.members.fetch(message.author.id).catch(() => null));
  if (!member?.permissions.has(PermissionFlagsBits.ManageGuild)) {
    await message.reply("❌ You need **Manage Server** permission to configure credit drops.");
    return;
  }

  const [, action = "status", ...args] = message.content.trim().split(/\s+/);
  const normalizedAction = action.toLowerCase();
  try {
    if (normalizedAction === "status") {
      const settings = await getCreditDropSettings(guild.id);
      await message.reply(
        settings
          ? `**Credit drop settings**\nChannel: <#${settings.channelId}>\nInterval: ${settings.intervalMinutes} minutes\nStatus: ${settings.enabled ? "enabled" : "paused"}\nNext drop: ${settings.enabled ? `<t:${Math.floor(settings.nextCrateAt / 1000)}:R>` : "paused"}\nActive drop: ${settings.activeMessageId ? `<#${settings.channelId}> (expires <t:${Math.floor((settings.activeExpiresAt ?? 0) / 1000)}:R>)` : "none"}\nTotal claimed: ${settings.totalCreditDropsClaimed.toLocaleString()}`
          : "Credit drops are not configured. Use `!creditdrop setup #channel`.",
      );
      return;
    }

    if (normalizedAction === "setup") {
      const mentioned = message.mentions.channels.first();
      const channel = mentioned ? guild.channels.cache.get(mentioned.id) : undefined;
      if (!channel || channel.type !== ChannelType.GuildText) {
        await message.reply("Usage: `!creditdrop setup #text-channel [30m]`.");
        return;
      }
      const intervalArgument = args.find((argument) => argument !== `<#${channel.id}>`);
      const intervalMinutes = intervalArgument
        ? parseInterval(intervalArgument)
        : DEFAULT_INTERVAL_MINUTES;
      if (!intervalMinutes) {
        await message.reply(`❌ Interval must be ${MIN_INTERVAL_MINUTES}m–24h, for example \`30m\` or \`2h\`.`);
        return;
      }
      const existing = await getCreditDropSettings(guild.id);
      const now = Date.now();
      if (existing?.activeMessageId) {
        const previousChannel = await guild.channels.fetch(existing.channelId).catch(() => null);
        const previousDrop = previousChannel?.isTextBased()
          ? await previousChannel.messages.fetch(existing.activeMessageId).catch(() => null)
          : null;
        if (previousDrop?.author.id === message.client.user?.id) {
          await previousDrop.delete().catch((error: unknown) => {
            logger.warn({ err: error, guildId: guild.id, messageId: existing.activeMessageId }, "Could not remove the previous scheduled drop");
          });
        }
      }
      await db
        .insert(botCrateSettingsTable)
        .values({
          guildId: guild.id,
          channelId: channel.id,
          intervalMinutes,
          enabled: true,
          nextCrateAt: now + intervalMinutes * 60_000,
        })
        .onConflictDoUpdate({
          target: botCrateSettingsTable.guildId,
          set: {
            channelId: channel.id,
            intervalMinutes,
            enabled: true,
            nextCrateAt: now + intervalMinutes * 60_000,
            activeMessageId: null,
            activeCreditReward: null,
            activeExpiresAt: null,
            updatedAt: new Date(now),
          },
        });
      await message.reply(
        `✅ Credit drops are enabled in ${channel}, every ${intervalMinutes} minutes. The first drop appears after that interval.`,
      );
      return;
    }

    if (normalizedAction === "interval") {
      const intervalMinutes = parseInterval(args[0]);
      if (!intervalMinutes) {
        await message.reply(`Usage: \`!creditdrop interval 30m\` (allowed: ${MIN_INTERVAL_MINUTES}m–24h).`);
        return;
      }
      const settings = await getCreditDropSettings(guild.id);
      if (!settings) {
        await message.reply("❌ Configure a channel first with `!creditdrop setup #channel`.");
        return;
      }
      const now = Date.now();
      await db.update(botCrateSettingsTable)
        .set({
          intervalMinutes,
          nextCrateAt: now + intervalMinutes * 60_000,
          updatedAt: new Date(now),
        })
        .where(eq(botCrateSettingsTable.guildId, guild.id));
      await message.reply(`✅ Credit drop interval set to ${intervalMinutes} minutes.`);
      return;
    }

    if (normalizedAction === "pause" || normalizedAction === "resume") {
      const enabled = normalizedAction === "resume";
      const settings = await getCreditDropSettings(guild.id);
      if (!settings) {
        await message.reply("❌ Configure a channel first with `!creditdrop setup #channel`.");
        return;
      }
      await db.update(botCrateSettingsTable)
        .set({
          enabled,
          nextCrateAt: enabled
            ? Date.now() + settings.intervalMinutes * 60_000
            : settings.nextCrateAt,
          updatedAt: new Date(),
        })
        .where(eq(botCrateSettingsTable.guildId, guild.id));
      await message.reply(`✅ Credit drops ${enabled ? "resumed" : "paused"}.`);
      return;
    }

    await message.reply("Usage: `!creditdrop setup #channel [30m]`, `!creditdrop interval 30m`, `!creditdrop status`, `!creditdrop pause`, or `!creditdrop resume`.");
  } catch (error) {
    logger.error({ err: error, guildId: guild.id, action: normalizedAction }, "Credit drop settings command failed");
    await message.reply("❌ Could not update credit drop settings. Please try again.");
  }
}

async function spawnCreditDrop(
  client: Client,
  settings: typeof botCrateSettingsTable.$inferSelect,
): Promise<void> {
  const channel = await client.channels.fetch(settings.channelId);
  if (!channel || channel.type !== ChannelType.GuildText || !channel.isSendable()) {
    throw new Error(`Configured credit drop channel ${settings.channelId} is unavailable or not a text channel`);
  }
  const expiresAt = Date.now() + CRATE_LIFETIME_MS;
  const message = await channel.send({ embeds: [creditDropEmbed(expiresAt)] });
  try {
    await message.react(REACTION);
    await db.update(botCrateSettingsTable)
      .set({
        activeMessageId: message.id,
        activeCreditReward: CREDIT_REWARD,
        activeExpiresAt: expiresAt,
        updatedAt: new Date(),
      })
      .where(eq(botCrateSettingsTable.guildId, settings.guildId));
  } catch (error) {
    await message.delete().catch(() => {});
    throw error;
  }
}

async function runScheduler(client: Client): Promise<void> {
  if (schedulerRunning) return;
  schedulerRunning = true;
  try {
    const settingsList = await db
      .select()
      .from(botCrateSettingsTable)
      .where(eq(botCrateSettingsTable.enabled, true));
    const now = Date.now();
    for (const settings of settingsList) {
      if (settings.activeMessageId && (settings.activeExpiresAt ?? 0) <= now) {
        await db.update(botCrateSettingsTable)
          .set({
            activeMessageId: null,
            activeCreditReward: null,
            activeExpiresAt: null,
            updatedAt: new Date(now),
          })
          .where(and(
            eq(botCrateSettingsTable.guildId, settings.guildId),
            eq(botCrateSettingsTable.activeMessageId, settings.activeMessageId),
          ));
      }
      if (settings.activeMessageId || settings.nextCrateAt > now) continue;

      const nextCrateAt = now + settings.intervalMinutes * 60_000;
      const [claimed] = await db.update(botCrateSettingsTable)
        .set({ nextCrateAt, updatedAt: new Date(now) })
        .where(and(
          eq(botCrateSettingsTable.guildId, settings.guildId),
          eq(botCrateSettingsTable.enabled, true),
          eq(botCrateSettingsTable.nextCrateAt, settings.nextCrateAt),
          isNull(botCrateSettingsTable.activeMessageId),
        ))
        .returning({ guildId: botCrateSettingsTable.guildId });
      if (!claimed) continue;

      try {
        await spawnCreditDrop(client, settings);
      } catch (error) {
        logger.error({ err: error, guildId: settings.guildId, channelId: settings.channelId }, "Could not spawn scheduled credit drop");
      }
    }
  } finally {
    schedulerRunning = false;
  }
}

export function startCreditDropScheduler(client: Client): void {
  if (scheduler) return;
  scheduler = setInterval(() => {
    void runScheduler(client).catch((error: unknown) => {
      logger.error({ err: error }, "Credit drop scheduler failed");
    });
  }, SCHEDULER_INTERVAL_MS);
  scheduler.unref();
  void runScheduler(client).catch((error: unknown) => {
    logger.error({ err: error }, "Initial credit drop scheduler run failed");
  });
}

export async function handleCreditDropReaction(reaction: MessageReaction, user: User): Promise<void> {
  if (user.bot || reaction.emoji.name !== REACTION) return;
  if (reaction.partial) await reaction.fetch();
  if (reaction.message.partial) await reaction.message.fetch();
  if (!reaction.message.guild) return;
  if (!reaction.message.embeds.some((embed) =>
    embed.title === "Credit Drop!" || embed.title === "A Credit Drop Has Appeared!"
  )) return;

  const now = Date.now();
  const result = await db.transaction(async (tx) => {
    const [settings] = await tx
      .select()
      .from(botCrateSettingsTable)
      .where(and(
        eq(botCrateSettingsTable.guildId, reaction.message.guild!.id),
        eq(botCrateSettingsTable.activeMessageId, reaction.message.id),
        isNotNull(botCrateSettingsTable.activeMessageId),
      ))
      .for("update");
    if (
      !settings ||
      !settings.activeCreditReward ||
      !settings.activeExpiresAt ||
      settings.activeExpiresAt <= now
    ) {
      return null;
    }

    await tx.insert(botMiningProfilesTable)
      .values({ guildId: settings.guildId, userId: user.id })
      .onConflictDoNothing();
    const [profile] = await tx.select({ coins: botMiningProfilesTable.coins })
      .from(botMiningProfilesTable)
      .where(and(
        eq(botMiningProfilesTable.guildId, settings.guildId),
        eq(botMiningProfilesTable.userId, user.id),
      ))
      .for("update");
    if (!profile) throw new Error("Could not load credit balance for drop winner");
    const credits = settings.activeCreditReward;
    const balance = profile.coins + credits;
    await tx.update(botMiningProfilesTable)
      .set({ coins: balance, updatedAt: new Date(now) })
      .where(and(
        eq(botMiningProfilesTable.guildId, settings.guildId),
        eq(botMiningProfilesTable.userId, user.id),
      ));
    const totalCreditDropsClaimed = settings.totalCreditDropsClaimed + 1;
    await tx.update(botCrateSettingsTable)
      .set({
        activeMessageId: null,
        activeCreditReward: null,
        activeExpiresAt: null,
        totalCreditDropsClaimed,
        updatedAt: new Date(now),
      })
      .where(eq(botCrateSettingsTable.guildId, settings.guildId));
    return { credits, balance, totalCreditDropsClaimed };
  });

  if (!result) return;
  try {
    await reaction.message.edit({
      content: `🎉 <@${user.id}>`,
      embeds: [
        new EmbedBuilder()
          .setColor(0x9b59b6)
          .setTitle("Credit Drop Claimed!")
          .setDescription(
            `**+${result.credits} Credits**\nBalance: **${result.balance.toLocaleString()} credits**`,
          ),
      ],
      allowedMentions: { users: [user.id] },
    });
  } catch (error) {
    logger.error(
      { err: error, guildId: reaction.message.guild.id, userId: user.id, messageId: reaction.message.id },
      "Could not announce crate winner",
    );
  }
}
