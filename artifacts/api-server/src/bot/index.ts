import {
  Client,
  GatewayIntentBits,
  Partials,
  type MessageReaction,
  type User,
} from "discord.js";
import { handleMessage } from "./commands";
import { handleAfkInteraction } from "./afk";
import { handleEmbedInteraction } from "./embeds";
import { handleSlashCommand, registerSlashCommands } from "./slash";
import { handleSocialBackButton, handleSocialGifButton } from "./social";
import { giveaways, buildGiveawayEmbed } from "./giveaway";
import { handleJtcInteraction, handleVoiceStateUpdate } from "./joinToCreate";
import { handleTicketInteraction } from "./tickets";
import { logger } from "../lib/logger";
import { processUserMessageAutomations, sendMemberMessage } from "./automation";
import { handleCreditDropReaction, startCreditDropScheduler } from "./crates";

export function createBot(): Client {
  const token = process.env["DISCORD_BOT_TOKEN"];
  if (!token) {
    logger.error("DISCORD_BOT_TOKEN is not set. Bot will not start.");
    return new Client({ intents: [] });
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildPresences,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.GuildVoiceStates,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
  });
  client.once("ready", () => {
    logger.info({ tag: client.user?.tag }, "Discord bot is ready");
    client.user?.setActivity("🎉 Giveaways | !help | /help");
    startCreditDropScheduler(client);
    void registerSlashCommands(client);
  });

  client.on("guildCreate", (guild) => {
    void registerSlashCommands(client).catch((err) => {
      logger.error({ err, guildId: guild.id }, "Failed to register commands for new guild");
    });
  });

  client.on("messageCreate", async (message) => {
    try {
      await handleMessage(client, message);
    } catch (err) {
      logger.error({ err }, "Error handling message");
    } finally {
      await processUserMessageAutomations(client, message);
    }
  });

  client.on("guildMemberAdd", (member) => {
    void sendMemberMessage(client, member, "welcome").catch((err) => {
      logger.error({ err, guildId: member.guild.id }, "Could not send welcome message");
    });
  });

  client.on("voiceStateUpdate", (oldState, newState) => {
    void handleVoiceStateUpdate(client, oldState, newState).catch((err) => {
      logger.error({ err, guildId: newState.guild.id }, "Error handling voice state update");
    });
  });

  client.on("interactionCreate", async (interaction) => {
    if (
      (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) &&
      interaction.customId.startsWith("embed-ui:")
    ) {
      try {
        await handleEmbedInteraction(interaction);
      } catch (err) {
        logger.error({ err, customId: interaction.customId }, "Error handling embed builder interaction");
      }
      return;
    }
    if (interaction.isButton() && interaction.customId.startsWith("social:back:")) {
      await handleSocialBackButton(interaction);
      return;
    }
    if (interaction.isButton() && interaction.customId.startsWith("social:gif:")) {
      try {
        await handleSocialGifButton(interaction);
      } catch (err) {
        logger.error({ err, customId: interaction.customId }, "Error handling social GIF carousel");
      }
      return;
    }
    if (interaction.isButton() && interaction.customId.startsWith("afk:dm:")) {
      try {
        await handleAfkInteraction(interaction);
      } catch (err) {
        logger.error({ err, customId: interaction.customId }, "Error handling AFK notification preference");
      }
      return;
    }
    if (interaction.isButton() && interaction.customId.startsWith("ticket:close:")) {
      await handleTicketInteraction(interaction);
      return;
    }
    if (
      (interaction.isButton() || interaction.isModalSubmit()) &&
      interaction.customId.startsWith("jtc:")
    ) {
      try {
        await handleJtcInteraction(interaction);
      } catch (err) {
        logger.error({ err, customId: interaction.customId }, "Error handling join-to-create interaction");
      }
      return;
    }
    if (!interaction.isChatInputCommand()) return;
    await handleSlashCommand(client, interaction);
  });

  client.on("messageReactionAdd", async (reaction: MessageReaction, user: User) => {
    try {
      if (user.bot) return;
      await handleCreditDropReaction(reaction, user);
      if (reaction.emoji.name !== "🎉") return;

      if (reaction.partial) await reaction.fetch();
      if (reaction.message.partial) await reaction.message.fetch();

      const giveaway = giveaways.get(reaction.message.id);
      if (!giveaway || giveaway.ended) return;

      giveaway.participants.add(user.id);

      await reaction.message.edit({
        embeds: [buildGiveawayEmbed(giveaway)],
      });
    } catch (err) {
      logger.error({ err }, "Error on reactionAdd");
    }
  });

  client.on("messageReactionRemove", async (reaction: MessageReaction, user: User) => {
    try {
      if (user.bot) return;
      if (reaction.emoji.name !== "🎉") return;

      if (reaction.partial) await reaction.fetch();
      if (reaction.message.partial) await reaction.message.fetch();

      const giveaway = giveaways.get(reaction.message.id);
      if (!giveaway || giveaway.ended) return;

      giveaway.participants.delete(user.id);

      await reaction.message.edit({
        embeds: [buildGiveawayEmbed(giveaway)],
      });
    } catch (err) {
      logger.error({ err }, "Error on reactionRemove");
    }
  });

  client.login(token).catch((err) => {
    logger.error({ err }, "Failed to login to Discord");
  });

  return client;
}
