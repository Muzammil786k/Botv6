import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  type Message,
} from "discord.js";
import { premiumColors } from "./presentation";
import { requireGameChannel } from "./gameChannel";

const TRUTH_PROMPTS = [
  "What is a small thing that always makes your day better?",
  "What is a skill you would love to learn?",
  "What is the funniest thing that happened to you recently?",
  "What is one song you never skip?",
  "What is your most harmless unpopular opinion?",
  "What is something you are proud of this week?",
];

const DARE_PROMPTS = [
  "Describe your day using only three emojis.",
  "Send a wholesome compliment to someone in this channel.",
  "Type your next message like a dramatic movie narrator.",
  "Share a fun fact about something you like.",
  "Write a two-line poem about your favorite snack.",
  "React to this message with the emoji that matches your mood.",
];

function randomPrompt(prompts: string[]): string {
  return prompts[Math.floor(Math.random() * prompts.length)]!;
}

export async function handleTruthOrDare(message: Message): Promise<void> {
  if (!message.guild || !(await requireGameChannel(message))) return;

  const targetId = message.mentions.users.first()?.id ?? message.author.id;
  const target = message.guild.members.cache.get(targetId) ??
    await message.guild.members.fetch(targetId).catch(() => null);
  if (!target) {
    await message.reply("❌ Could not find the player. Usage: `!truthordare [@player]`.");
    return;
  }
  if (target.user.bot) {
    await message.reply("❌ Bots can't play Truth or Dare.");
    return;
  }

  const promptMessage = await message.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(premiumColors.brand)
        .setDescription(`<@${target.id}>, choose **Truth** or **Dare**.`),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("truthordare:truth")
          .setLabel("Truth")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId("truthordare:dare")
          .setLabel("Dare")
          .setStyle(ButtonStyle.Danger),
      ),
    ],
    allowedMentions: { users: [target.id] },
  });

  const collector = promptMessage.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 60_000,
  });

  collector.on("collect", async (interaction) => {
    if (interaction.user.id !== target.id) {
      await interaction.reply({ content: "Only the selected player can choose Truth or Dare.", ephemeral: true });
      return;
    }

    const isTruth = interaction.customId === "truthordare:truth";
    await interaction.update({
      embeds: [
        new EmbedBuilder()
          .setColor(premiumColors.brand)
          .setDescription(
            `<@${target.id}> chose **${isTruth ? "Truth" : "Dare"}**.\n\n${randomPrompt(isTruth ? TRUTH_PROMPTS : DARE_PROMPTS)}`,
          ),
      ],
      components: [],
    });
    collector.stop("chosen");
  });

  collector.on("end", async (_collected, reason) => {
    if (reason !== "chosen") {
      await promptMessage.edit({ components: [] }).catch(() => {});
    }
  });
}