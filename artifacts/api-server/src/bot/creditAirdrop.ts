import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  type ButtonInteraction,
  type Client,
  type Message,
  type TextChannel,
} from "discord.js";
import { and, eq, lte } from "drizzle-orm";
import { botCreditAirdropsTable, botMiningProfilesTable, db } from "@workspace/db";
import { logger } from "../lib/logger";
import { premiumColors } from "./presentation";

const MIN_DURATION_MS = 10_000;
const MAX_DURATION_MS = 7 * 24 * 60 * 60_000;
const MAX_CREDITS = 2_147_483_647;
const MAX_ENTRANTS = 1000;
const SCHEDULER_INTERVAL_MS = 5_000;
const JOIN_PREFIX = "creditairdrop:join:";

let scheduler: NodeJS.Timeout | undefined;
let schedulerRunning = false;
const startingGuilds = new Set<string>();

interface AirdropWinner {
  userId: string;
  credits: number;
}

function parseDuration(value: string | undefined): number | null {
  const match = /^(\d+)(s|m|h|d)$/i.exec(value ?? "");
  if (!match) return null;
  const amount = Number(match[1]);
  const multiplier = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]!.toLowerCase() as "s" | "m" | "h" | "d"];
  const duration = amount * multiplier;
  return Number.isSafeInteger(duration) && duration >= MIN_DURATION_MS && duration <= MAX_DURATION_MS
    ? duration
    : null;
}

function createAirdropEmbed(totalCredits: number, expiresAt: number, ended = false, entrants = 0): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(premiumColors.brand)
    .setTitle("💸 Credit Airdrop")
    .setDescription(ended
      ? `<:53:1553581922020499466> **${totalCredits.toLocaleString()} credits** airdrop ended.\nEntries: **${entrants}**`
      : `<:53:1553581922020499466> **${totalCredits.toLocaleString()} credits** up for grabs!\nJoin to split the pot equally. Ends <t:${Math.floor(expiresAt / 1000)}:R>.`);
}

function joinButton(messageId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${JOIN_PREFIX}${messageId}`)
      .setLabel("Enter Airdrop")
      .setEmoji("🎉")
      .setStyle(ButtonStyle.Success),
  );
}

async function announceWinners(
  channel: TextChannel,
  winners: AirdropWinner[],
): Promise<void> {
  if (winners.length === 0) {
    await channel.send("The credit airdrop ended with no entries.");
    return;
  }

  let batch: AirdropWinner[] = [];
  let content = "🎉 Congratulations to the airdrop winners!\n";
  for (const winner of winners) {
    const line = `<@${winner.userId}> — **${winner.credits.toLocaleString()} credits**\n`;
    if (content.length + line.length > 1800 && batch.length > 0) {
      await channel.send({
        content,
        allowedMentions: { users: batch.map((entry) => entry.userId) },
      });
      batch = [];
      content = "🎉 More airdrop winners!\n";
    }
    content += line;
    batch.push(winner);
  }

  if (batch.length > 0) {
    await channel.send({
      content,
      allowedMentions: { users: batch.map((entry) => entry.userId) },
    });
  }
}

async function finalizeCreditAirdrop(client: Client, guildId: string, messageId: string): Promise<void> {
  const result = await db.transaction(async (tx) => {
    const [airdrop] = await tx.select()
      .from(botCreditAirdropsTable)
      .where(and(
        eq(botCreditAirdropsTable.guildId, guildId),
        eq(botCreditAirdropsTable.messageId, messageId),
      ))
      .for("update");
    if (!airdrop || airdrop.expiresAt > Date.now()) return null;

    const entrants = [...new Set(airdrop.entrants)].slice(0, MAX_ENTRANTS);
    const winners: AirdropWinner[] = [];
    if (entrants.length > 0) {
      const baseShare = Math.floor(airdrop.totalCredits / entrants.length);
      const remainder = airdrop.totalCredits % entrants.length;
      await tx.insert(botMiningProfilesTable)
        .values(entrants.map((userId) => ({ guildId, userId })))
        .onConflictDoNothing();

      for (const [index, userId] of entrants.entries()) {
        const credits = baseShare + (index < remainder ? 1 : 0);
        const [profile] = await tx.select({ coins: botMiningProfilesTable.coins })
          .from(botMiningProfilesTable)
          .where(and(
            eq(botMiningProfilesTable.guildId, guildId),
            eq(botMiningProfilesTable.userId, userId),
          ))
          .for("update");
        if (!profile) throw new Error(`Could not load airdrop winner profile ${userId}`);

        await tx.update(botMiningProfilesTable)
          .set({ coins: profile.coins + credits, updatedAt: new Date() })
          .where(and(
            eq(botMiningProfilesTable.guildId, guildId),
            eq(botMiningProfilesTable.userId, userId),
          ));
        winners.push({ userId, credits });
      }
    }

    await tx.delete(botCreditAirdropsTable)
      .where(and(
        eq(botCreditAirdropsTable.guildId, guildId),
        eq(botCreditAirdropsTable.messageId, messageId),
      ));

    return {
      channelId: airdrop.channelId,
      totalCredits: airdrop.totalCredits,
      expiresAt: airdrop.expiresAt,
      entrantsCount: entrants.length,
      winners,
    };
  });

  if (!result) return;
  const channel = await client.channels.fetch(result.channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) {
    logger.error({ guildId, channelId: result.channelId }, "Airdrop channel is unavailable at payout time");
    return;
  }

  const dropMessage = await channel.messages.fetch(messageId).catch(() => null);
  if (dropMessage) {
    await dropMessage.edit({
      embeds: [createAirdropEmbed(result.totalCredits, result.expiresAt, true, result.entrantsCount)],
      components: [],
    }).catch((err) => {
      logger.warn({ err, guildId, messageId }, "Could not mark airdrop message as ended");
    });
  }

  await announceWinners(channel, result.winners).catch((err) => {
    logger.error({ err, guildId, messageId }, "Could not announce credit airdrop winners");
  });
}

export async function handleCreditAirdropCommand(message: Message, args: string[]): Promise<void> {
  const guild = message.guild;
  if (!guild) return;

  const member = message.member ?? await guild.members.fetch(message.author.id).catch(() => null);
  if (!member?.permissions.has(PermissionFlagsBits.ManageGuild) && !member?.permissions.has(PermissionFlagsBits.Administrator)) {
    await message.reply("❌ You need **Manage Server** permission to start a credit airdrop.");
    return;
  }

  const totalCredits = Number(args[0]);
  const duration = parseDuration(args[1]);
  if (!Number.isSafeInteger(totalCredits) || totalCredits < 1 || totalCredits > MAX_CREDITS || !duration) {
    await message.reply("Usage: `!airdrop <credits> <duration>` (example: `!airdrop 200 10m`; duration `10s`–`7d`).");
    return;
  }
  if (message.channel.type !== ChannelType.GuildText) {
    await message.reply("❌ Start the airdrop in a server text channel.");
    return;
  }
  if (startingGuilds.has(guild.id)) {
    await message.reply("⏳ An airdrop is already being created for this server.");
    return;
  }

  startingGuilds.add(guild.id);
  try {
    const [existing] = await db.select()
      .from(botCreditAirdropsTable)
      .where(eq(botCreditAirdropsTable.guildId, guild.id))
      .limit(1);
    if (existing && existing.expiresAt > Date.now()) {
      await message.reply(`❌ An airdrop is already active in <#${existing.channelId}>.`);
      return;
    }
    if (existing) await finalizeCreditAirdrop(message.client, guild.id, existing.messageId);

    const expiresAt = Date.now() + duration;
    const channel = message.channel as TextChannel;
    const dropMessage = await channel.send({
      embeds: [createAirdropEmbed(totalCredits, expiresAt)],
    });
    try {
      const [created] = await db.insert(botCreditAirdropsTable)
        .values({
          guildId: guild.id,
          channelId: channel.id,
          messageId: dropMessage.id,
          totalCredits,
          expiresAt,
          entrants: [],
        })
        .onConflictDoNothing()
        .returning({ guildId: botCreditAirdropsTable.guildId });
      if (!created) {
        await dropMessage.delete().catch(() => {});
        await message.reply("❌ Another airdrop was just created for this server.");
        return;
      }
      await dropMessage.edit({
        embeds: [createAirdropEmbed(totalCredits, expiresAt)],
        components: [joinButton(dropMessage.id)],
      });
      await message.reply(`✅ Credit airdrop started for **${totalCredits.toLocaleString()} credits** in ${channel}.`);
    } catch (err) {
      await db.delete(botCreditAirdropsTable)
        .where(and(
          eq(botCreditAirdropsTable.guildId, guild.id),
          eq(botCreditAirdropsTable.messageId, dropMessage.id),
        )).catch(() => {});
      await dropMessage.delete().catch(() => {});
      throw err;
    }
  } catch (err) {
    logger.error({ err, guildId: guild.id, userId: message.author.id }, "Failed to start credit airdrop");
    await message.reply("❌ Could not start the credit airdrop. Please try again.").catch(() => {});
  } finally {
    startingGuilds.delete(guild.id);
  }
}

export async function handleCreditAirdropButton(interaction: ButtonInteraction): Promise<void> {
  const messageId = interaction.customId.slice(JOIN_PREFIX.length);
  const guild = interaction.guild;
  if (!guild || interaction.user.bot) {
    await interaction.reply({ content: "This airdrop can only be joined by a server member.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  try {
    const result = await db.transaction(async (tx) => {
      const [airdrop] = await tx.select()
        .from(botCreditAirdropsTable)
        .where(and(
          eq(botCreditAirdropsTable.guildId, guild.id),
          eq(botCreditAirdropsTable.messageId, messageId),
        ))
        .for("update");
      if (!airdrop) return { status: "closed" as const };
      if (airdrop.expiresAt <= Date.now()) return { status: "expired" as const };
      if (airdrop.entrants.includes(interaction.user.id)) return { status: "joined" as const };
      if (airdrop.entrants.length >= Math.min(MAX_ENTRANTS, airdrop.totalCredits)) {
        return { status: "full" as const };
      }

      await tx.update(botCreditAirdropsTable)
        .set({ entrants: [...airdrop.entrants, interaction.user.id] })
        .where(eq(botCreditAirdropsTable.guildId, guild.id));
      return { status: "entered" as const };
    });

    if (result.status === "entered") {
      await interaction.editReply("✅ You're entered in the credit airdrop!");
    } else if (result.status === "joined") {
      await interaction.editReply("You're already entered in this airdrop.");
    } else if (result.status === "full") {
      await interaction.editReply("This airdrop has reached its maximum number of entries.");
    } else {
      await interaction.editReply("This airdrop has ended.");
      if (result.status === "expired") {
        void finalizeCreditAirdrop(interaction.client, guild.id, messageId).catch((err) => {
          logger.error({ err, guildId: guild.id, messageId }, "Could not finalize expired airdrop");
        });
      }
    }
  } catch (err) {
    logger.error({ err, guildId: guild.id, messageId, userId: interaction.user.id }, "Failed to enter credit airdrop");
    await interaction.editReply("❌ Could not enter the airdrop. Please try again.").catch(() => {});
  }
}

export function startCreditAirdropScheduler(client: Client): void {
  if (scheduler) return;

  const finalizeExpired = async () => {
    if (schedulerRunning) return;
    schedulerRunning = true;
    try {
      const expired = await db.select({ guildId: botCreditAirdropsTable.guildId, messageId: botCreditAirdropsTable.messageId })
        .from(botCreditAirdropsTable)
        .where(lte(botCreditAirdropsTable.expiresAt, Date.now()));
      for (const airdrop of expired) {
        await finalizeCreditAirdrop(client, airdrop.guildId, airdrop.messageId).catch((err) => {
          logger.error({ err, guildId: airdrop.guildId, messageId: airdrop.messageId }, "Failed to finalize expired credit airdrop");
        });
      }
    } catch (err) {
      logger.error({ err }, "Credit airdrop scheduler failed");
    } finally {
      schedulerRunning = false;
    }
  };

  scheduler = setInterval(() => void finalizeExpired(), SCHEDULER_INTERVAL_MS);
  scheduler.unref();
  void finalizeExpired();
}