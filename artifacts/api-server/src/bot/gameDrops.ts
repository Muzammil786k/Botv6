import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ComponentType,
  EmbedBuilder,
  StringSelectMenuBuilder,
  type Client,
  type Guild,
  type Message,
  type StringSelectMenuInteraction,
  type TextChannel,
} from "discord.js";
import { sql } from "drizzle-orm";
import { botMiningProfilesTable, db } from "@workspace/db";
import { createRequire } from "node:module";
import { logger } from "../lib/logger";

const require = createRequire(import.meta.url);
const englishWords = new Set<string>((require("an-array-of-english-words") as string[]).map((word) => word.toLowerCase()));
const DROP_CHANNEL_ID = "731254148678549595";
const DROP_INTERVAL_MS = 30 * 60_000;
const ROUND_TIME_MS = 60_000;
const GAME_WIN_CREDITS = 20;
const GAME_COLOR = 0x5865f2;

interface GameOption {
  id: string;
  label: string;
  emoji: string;
}

const gameOptions: GameOption[] = [
  { id: "button-hunt", label: "Button Hunt", emoji: "<:click:1338116032237273108>" },
  { id: "dice-roll-duel", label: "Dice Roll Duel", emoji: "<:dice:1371660988251770910>" },
  { id: "word-backwards", label: "Word Backwards", emoji: "<a:chat:1385853571353804971>" },
  { id: "word-scramble", label: "Word Scramble", emoji: "<:scramble:1543186617294921728>" },
  { id: "guess-celebrity", label: "Guess the Celebrity", emoji: "<:GrayUser:1350089486880735313>" },
  { id: "pattern-puzzle", label: "Pattern Puzzle", emoji: "<:maths:1388920563854086285>" },
  { id: "capital-scramble", label: "Capital Scramble", emoji: "<:world:1488996051384799342>" },
  { id: "red-light-green-light", label: "Red Light Green Light", emoji: "<a:Trafficlight:1388468073505230879>" },
  { id: "missing-emoji", label: "Missing Emoji", emoji: ":question:" },
  { id: "sequence-hunt", label: "Sequence Hunt", emoji: "<:Repeat:1387821949345988618>" },
  { id: "color-hunt", label: "Color Hunt", emoji: "<:Color:1537451944291868692>" },
  { id: "emoji-equation", label: "Emoji Equation", emoji: "<:quest:1505085975993389077>" },
  { id: "flag", label: "Flag", emoji: "<:world:1488996051384799342>" },
  { id: "reaction", label: "Reaction", emoji: "<:reaction:1537503043417940109>" },
  { id: "language", label: "Language", emoji: "<:category:1537451490946326558>" },
  { id: "word", label: "Word", emoji: "<:edit:1479903246511505552>" },
  { id: "nickname", label: "Nickname", emoji: "<:GrayUser:1350089486880735313>" },
  { id: "emoji", label: "Emoji", emoji: "<:smile:1347194662762450966>" },
  { id: "trivia", label: "Trivia", emoji: "<:search:1459941053326164069>" },
  { id: "hilo", label: "HILO", emoji: "<:rankings:1349313572429234206>" },
];

interface Choice {
  label: string;
  emoji?: string;
}

type GameChallenge =
  | { kind: "answer"; prompt: string; answers: string[] }
  | { kind: "validate"; prompt: string; test: (answer: string) => boolean }
  | { kind: "memory"; sequence: string; prompt: string }
  | { kind: "choices"; prompt: string; choices: Choice[]; correctIndex: number }
  | { kind: "dice" }
  | { kind: "traffic" };

let scheduler: NodeJS.Timeout | null = null;
const consumedDrops = new Set<string>();
const activeGameChannels = new Set<string>();

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

function shuffle<T>(items: readonly T[]): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex]!, result[index]!];
  }
  return result;
}

function normalizeAnswer(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[\s.,!?;:]/g, "");
}

function asComponentEmoji(value: string): string | { id: string; name: string; animated?: boolean } {
  if (value === ":question:") return "❓";
  const match = /^<(a?):([a-zA-Z0-9_]+):(\d+)>$/.exec(value);
  return match
    ? { id: match[3]!, name: match[2]!, animated: match[1] === "a" }
    : value;
}

function formatDropMessage(channelId: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(GAME_COLOR)
    .setDescription(
      `<:pin:1389048592844460102> **chat** <:lounge1:1349318294867284040> <#${channelId}>\n` +
      `<:hourglass:1514489135753072700> **Cooldown:** **\`30 minutes\`**\n\n` +
      `<:controller:1386699997290172559> **Choose a game to drop**`,
    );
}

async function postGameDrop(client: Client): Promise<void> {
  try {
    const channel = await client.channels.fetch(DROP_CHANNEL_ID);
    if (!channel || channel.type !== ChannelType.GuildText) {
      logger.error({ channelId: DROP_CHANNEL_ID }, "Game drop channel is missing or is not a text channel");
      return;
    }

    const menu = new StringSelectMenuBuilder()
      .setCustomId(`game-drop:${Date.now()}`)
      .setPlaceholder("Select a game to drop")
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(gameOptions.map((game) => ({
        label: game.label,
        value: game.id,
        emoji: asComponentEmoji(game.emoji),
      })));
    await channel.send({
      embeds: [formatDropMessage(channel.id)],
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
    });
  } catch (error) {
    logger.error({ err: error, channelId: DROP_CHANNEL_ID }, "Could not post scheduled game drop");
  }
}

export function startGameDropScheduler(client: Client): void {
  if (scheduler) return;
  void postGameDrop(client);
  scheduler = setInterval(() => void postGameDrop(client), DROP_INTERVAL_MS);
  scheduler.unref();
}

export async function handleGamesCommand(message: Message): Promise<void> {
  await message.reply({
    embeds: [new EmbedBuilder()
      .setColor(GAME_COLOR)
      .setTitle("Game Drop Games")
      .setDescription(gameOptions.map((game) => `${game.emoji} **${game.label}**`).join("\n"))
      .setFooter({ text: "Pick a game from the scheduled dropdown to start a round." })],
    allowedMentions: { parse: [] },
  });
}

function createChallenge(gameId: string, guild: Guild): GameChallenge {
  switch (gameId) {
    case "button-hunt": {
      const symbols = ["🌙", "⭐", "🔥", "💎", "🍀"];
      const choices = shuffle(symbols);
      const correctIndex = Math.floor(Math.random() * choices.length);
      return {
        kind: "choices",
        prompt: `Find and click **${choices[correctIndex]}** before anyone else.`,
        choices: choices.map((emoji, index) => ({ label: String(index + 1), emoji })),
        correctIndex,
      };
    }
    case "dice-roll-duel":
      return { kind: "dice" };
    case "word-backwards": {
      const word = pick(["hangouts", "discord", "rainbow", "planet", "lantern"]);
      return { kind: "answer", prompt: `Type this word forwards: **${Array.from(word).reverse().join("")}**`, answers: [word] };
    }
    case "word-scramble": {
      const word = pick(["lantern", "galaxy", "discord", "puzzle", "rainbow"]);
      const letters = shuffle(Array.from(word));
      if (letters.join("") === word) [letters[0], letters[1]] = [letters[1]!, letters[0]!];
      return { kind: "answer", prompt: `Unscramble this word: **${letters.join("").toUpperCase()}**`, answers: [word] };
    }
    case "guess-celebrity": {
      const entries = [
        { clue: "He played Iron Man in the Marvel films.", answer: "Robert Downey Jr.", aliases: ["rdj"] },
        { clue: "She played Hermione Granger in the Harry Potter films.", answer: "Emma Watson", aliases: [] },
        { clue: "He is known as the King of Pop and sang 'Thriller'.", answer: "Michael Jackson", aliases: [] },
      ];
      const entry = pick(entries);
      return { kind: "answer", prompt: entry.clue, answers: [entry.answer, ...entry.aliases] };
    }
    case "pattern-puzzle": {
      const patterns = [
        { prompt: "Complete the pattern: **2, 6, 12, 20, ?**", answer: "30" },
        { prompt: "Complete the pattern: **1, 1, 2, 3, 5, ?**", answer: "8" },
        { prompt: "Complete the pattern: **3, 6, 12, 24, ?**", answer: "48" },
      ];
      const pattern = pick(patterns);
      return { kind: "answer", prompt: pattern.prompt, answers: [pattern.answer] };
    }
    case "capital-scramble": {
      const entries = [
        { prompt: "Unscramble this capital: **NODLON**", answer: "London" },
        { prompt: "Unscramble this capital: **SIPRA**", answer: "Paris" },
        { prompt: "Unscramble this capital: **KOTYO**", answer: "Tokyo" },
      ];
      const entry = pick(entries);
      return { kind: "answer", prompt: entry.prompt, answers: [entry.answer] };
    }
    case "red-light-green-light":
      return { kind: "traffic" };
    case "missing-emoji": {
      const choices = ["🐹", "🐸", "🐻", "🐼"];
      return {
        kind: "choices",
        prompt: "Which emoji completes this sequence? **🐶 🐱 ❓ 🐰**",
        choices: choices.map((emoji, index) => ({ label: String.fromCharCode(65 + index), emoji })),
        correctIndex: 0,
      };
    }
    case "sequence-hunt": {
      const sequence = pick(["🌙 ⭐ 🔥 🍀", "🍎 🚀 🎈 🐳", "🎲 🌈 🧩 🪐"]);
      return { kind: "memory", sequence, prompt: "Repeat the emoji sequence in the correct order." };
    }
    case "color-hunt": {
      const colors = ["🔴", "🔵", "🟢", "🟡"];
      const correctIndex = Math.floor(Math.random() * colors.length);
      return {
        kind: "choices",
        prompt: `Click the **${["red", "blue", "green", "yellow"][correctIndex]}** color.`,
        choices: colors.map((emoji, index) => ({ label: String(index + 1), emoji })),
        correctIndex,
      };
    }
    case "emoji-equation":
      return { kind: "answer", prompt: "If 🐱 = 4 and 🐶 = 6, what is 🐱 + 🐶?", answers: ["10"] };
    case "flag": {
      const flags = [
        { emoji: "🇯🇵", answer: "Japan" },
        { emoji: "🇫🇷", answer: "France" },
        { emoji: "🇧🇷", answer: "Brazil" },
        { emoji: "🇨🇦", answer: "Canada" },
        { emoji: "🇮🇳", answer: "India" },
      ];
      const flag = pick(flags);
      return { kind: "answer", prompt: `Which country does this flag belong to? **${flag.emoji}**`, answers: [flag.answer] };
    }
    case "reaction": {
      const emojis = ["🎯", "💥", "⚡", "🎈", "🧊"];
      const correctIndex = Math.floor(Math.random() * emojis.length);
      return {
        kind: "choices",
        prompt: `React fast: click **${emojis[correctIndex]}**.`,
        choices: emojis.map((emoji, index) => ({ label: String(index + 1), emoji })),
        correctIndex,
      };
    }
    case "language": {
      const entries = [
        { prompt: "Translate **hello** into Spanish.", answer: "hola" },
        { prompt: "Translate **thank you** into French.", answer: "merci" },
        { prompt: "Translate **goodbye** into Italian.", answer: "arrivederci" },
      ];
      const entry = pick(entries);
      return { kind: "answer", prompt: entry.prompt, answers: [entry.answer] };
    }
    case "word": {
      return {
        kind: "validate",
        prompt: "Type a real English word with at least 6 letters that **starts with S and ends with T**.",
        test: (value) => englishWords.has(value.trim().toLowerCase()) && value.trim().length >= 6 && value.trim().toLowerCase().startsWith("s") && value.trim().toLowerCase().endsWith("t"),
      };
    }
    case "nickname": {
      const members = [...guild.members.cache.values()].filter((member) => !member.user.bot && member.nickname);
      const member = members.length > 0 ? pick(members) : null;
      return member
        ? { kind: "answer", prompt: `Which Discord username belongs to the member with the nickname **${member.displayName}**?`, answers: [member.user.username] }
        : { kind: "answer", prompt: "What do you call a custom display name set for one Discord server?", answers: ["nickname", "server nickname"] };
    }
    case "emoji": {
      const entries = [
        { prompt: "Decode the emoji clue: **🌧️ + 🏹**", answer: "rainbow", aliases: ["rain bow"] },
        { prompt: "Decode the emoji clue: **⭐ + 🐟**", answer: "starfish", aliases: ["star fish"] },
        { prompt: "Decode the emoji clue: **🧈 + 🪰**", answer: "butterfly", aliases: ["butter fly"] },
      ];
      const entry = pick(entries);
      return { kind: "answer", prompt: entry.prompt, answers: [entry.answer, ...entry.aliases] };
    }
    case "trivia": {
      const entries = [
        { prompt: "Which planet is the largest in our solar system?", answer: "Jupiter" },
        { prompt: "How many sides does a hexagon have?", answer: "6" },
        { prompt: "What is the largest ocean on Earth?", answer: "Pacific Ocean", aliases: ["Pacific"] },
      ];
      const entry = pick(entries);
      return { kind: "answer", prompt: entry.prompt, answers: [entry.answer, ...(entry.aliases ?? [])] };
    }
    case "hilo": {
      const current = Math.floor(Math.random() * 11) + 2;
      const nextOptions = Array.from({ length: 13 }, (_, index) => index + 1).filter((value) => value !== current);
      const next = pick(nextOptions);
      const correctIndex = next > current ? 0 : 1;
      return {
        kind: "choices",
        prompt: `The current card is **${current}**. Will the next card be higher or lower?`,
        choices: [{ label: "Higher", emoji: "⬆️" }, { label: "Lower", emoji: "⬇️" }],
        correctIndex,
      };
    }
    default:
      throw new Error(`Unknown game drop: ${gameId}`);
  }
}

async function sendGameResult(channel: TextChannel, gameName: string, winnerId: string | null, wonByDefault = false): Promise<void> {
  let rewardGranted = false;
  if (winnerId) {
    try {
      await db.insert(botMiningProfilesTable)
        .values({ guildId: channel.guild.id, userId: winnerId, coins: GAME_WIN_CREDITS })
        .onConflictDoUpdate({
          target: [botMiningProfilesTable.guildId, botMiningProfilesTable.userId],
          set: {
            coins: sql<number>`${botMiningProfilesTable.coins} + ${GAME_WIN_CREDITS}`,
            updatedAt: new Date(),
          },
        });
      rewardGranted = true;
    } catch (error) {
      logger.error({ err: error, guildId: channel.guild.id, userId: winnerId, gameName }, "Could not grant game-drop credits");
    }
  }

  await channel.send({
    embeds: [new EmbedBuilder()
      .setColor(GAME_COLOR)
      .setDescription(winnerId
        ? `🏆 <@${winnerId}> ${wonByDefault ? `won **${gameName}** by default` : `won **${gameName}**`}${rewardGranted ? ` and earned **${GAME_WIN_CREDITS} credits**!` : " (credits could not be added; please contact staff)."}`
        : `⌛ **${gameName}** ended with no winner. Time for the next drop!`)],
    allowedMentions: winnerId ? { users: [winnerId] } : { parse: [] },
  });
}

async function runAnswerGame(
  channel: TextChannel,
  gameName: string,
  prompt: string,
  isCorrect: (answer: string, userId: string) => boolean,
  existingMessage?: Message,
): Promise<void> {
  const gameMessage = existingMessage ?? await channel.send({
    embeds: [new EmbedBuilder()
      .setColor(GAME_COLOR)
      .setTitle(gameName)
      .setDescription(`${prompt}\n\n**First correct answer wins!** You have 60 seconds.`)],
  });
  let winnerId: string | null = null;
  await new Promise<void>((resolve) => {
    const collector = channel.createMessageCollector({
      time: ROUND_TIME_MS,
      filter: (message) => !message.author.bot,
    });
    collector.on("collect", (message) => {
      if (isCorrect(message.content, message.author.id)) {
        winnerId = message.author.id;
        collector.stop("winner");
      }
    });
    collector.on("end", () => resolve());
  });
  await gameMessage.edit({ components: [] }).catch(() => {});
  await sendGameResult(channel, gameName, winnerId);
}

async function runMemoryGame(channel: TextChannel, gameName: string, challenge: Extract<GameChallenge, { kind: "memory" }>): Promise<void> {
  const message = await channel.send({
    embeds: [new EmbedBuilder().setColor(GAME_COLOR).setTitle(gameName).setDescription(`Memorize this sequence:\n\n## ${challenge.sequence}\n\nIt will disappear in 5 seconds.`)],
  });
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  await message.edit({
    embeds: [new EmbedBuilder().setColor(GAME_COLOR).setTitle(gameName).setDescription(`${challenge.prompt}\n\n**First correct answer wins!** You have 60 seconds.`)],
  });
  await runAnswerGame(channel, gameName, "Repeat the hidden emoji sequence.", (answer) => normalizeAnswer(answer) === normalizeAnswer(challenge.sequence), message);
}

async function runChoiceGame(channel: TextChannel, gameName: string, challenge: Extract<GameChallenge, { kind: "choices" }>): Promise<void> {
  const token = Math.random().toString(36).slice(2, 9);
  const buttons = challenge.choices.map((choice, index) => {
    const button = new ButtonBuilder()
      .setCustomId(`game-drop-choice:${token}:${index}`)
      .setLabel(choice.label)
      .setStyle(ButtonStyle.Secondary);
    if (choice.emoji) button.setEmoji(choice.emoji);
    return button;
  });
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let offset = 0; offset < buttons.length; offset += 5) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(offset, offset + 5)));
  }
  const message = await channel.send({
    embeds: [new EmbedBuilder().setColor(GAME_COLOR).setTitle(gameName).setDescription(`${challenge.prompt}\n\n**Choose quickly!** You have 45 seconds.`)],
    components: rows,
  });
  let winnerId: string | null = null;
  await new Promise<void>((resolve) => {
    const collector = message.createMessageComponentCollector({ componentType: ComponentType.Button, time: 45_000 });
    collector.on("collect", async (interaction) => {
      if (!interaction.customId.startsWith(`game-drop-choice:${token}:`)) return;
      const choiceIndex = Number(interaction.customId.split(":").at(-1));
      if (choiceIndex === challenge.correctIndex) {
        winnerId = interaction.user.id;
        await interaction.deferUpdate();
        collector.stop("winner");
      } else {
        await interaction.reply({ content: "Not that one. Keep trying!", ephemeral: true });
      }
    });
    collector.on("end", () => resolve());
  });
  await message.edit({ components: [] }).catch(() => {});
  await sendGameResult(channel, gameName, winnerId);
}

async function runDiceDuel(channel: TextChannel, gameName: string): Promise<void> {
  const token = Math.random().toString(36).slice(2, 9);
  const button = new ButtonBuilder().setCustomId(`game-drop-dice:${token}`).setLabel("Roll d20").setEmoji("🎲").setStyle(ButtonStyle.Primary);
  const message = await channel.send({
    embeds: [new EmbedBuilder().setColor(GAME_COLOR).setTitle(gameName).setDescription("Two players roll a d20. Highest roll wins! Click once to enter.")],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)],
  });
  const rolls = new Map<string, number>();
  await new Promise<void>((resolve) => {
    const collector = message.createMessageComponentCollector({ componentType: ComponentType.Button, time: 30_000 });
    collector.on("collect", async (interaction) => {
      if (interaction.customId !== `game-drop-dice:${token}`) return;
      if (rolls.has(interaction.user.id)) {
        await interaction.reply({ content: "You already rolled.", ephemeral: true });
        return;
      }
      if (rolls.size >= 2) {
        await interaction.reply({ content: "This duel already has two players.", ephemeral: true });
        return;
      }
      const result = Math.floor(Math.random() * 20) + 1;
      rolls.set(interaction.user.id, result);
      await interaction.reply({ content: `You rolled **${result}**!`, ephemeral: true });
      const scores = [...rolls].map(([userId, score]) => `<@${userId}>: **${score}**`).join("\n");
      await message.edit({ embeds: [new EmbedBuilder().setColor(GAME_COLOR).setTitle(gameName).setDescription(`${scores}\n\nWaiting for ${2 - rolls.size} more player(s).`)] });
      if (rolls.size === 2) collector.stop("complete");
    });
    collector.on("end", () => resolve());
  });
  const scores = [...rolls.entries()].sort((left, right) => right[1] - left[1]);
  const winnerId = scores.length === 0 ? null : scores[0]![0];
  await message.edit({ components: [] }).catch(() => {});
  if (scores.length === 1) {
    await sendGameResult(channel, gameName, scores[0]![0], true);
  } else if (scores.length === 2 && scores[0]![1] === scores[1]![1]) {
    await channel.send(`It's a tie! Both players rolled **${scores[0]![1]}**. Start another duel next drop.`);
  } else {
    await sendGameResult(channel, gameName, winnerId);
  }
}

async function runTrafficGame(channel: TextChannel, gameName: string): Promise<void> {
  const message = await channel.send({
    embeds: [new EmbedBuilder().setColor(0xe74c3c).setTitle(gameName).setDescription("🔴 **Red light!** Wait for green before clicking...")],
  });
  await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 3_000) + 2_000));
  const token = Math.random().toString(36).slice(2, 9);
  const button = new ButtonBuilder().setCustomId(`game-drop-green:${token}`).setLabel("GO!").setEmoji("🟢").setStyle(ButtonStyle.Success);
  await message.edit({
    embeds: [new EmbedBuilder().setColor(0x2ecc71).setTitle(gameName).setDescription("🟢 **Green light!** Click first to win!")],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)],
  });
  let winnerId: string | null = null;
  await new Promise<void>((resolve) => {
    const collector = message.createMessageComponentCollector({ componentType: ComponentType.Button, time: 30_000, max: 1 });
    collector.on("collect", async (interaction) => {
      if (interaction.customId !== `game-drop-green:${token}`) return;
      winnerId = interaction.user.id;
      await interaction.deferUpdate();
    });
    collector.on("end", () => resolve());
  });
  await message.edit({ components: [] }).catch(() => {});
  await sendGameResult(channel, gameName, winnerId);
}

async function playGame(channel: TextChannel, guild: Guild, game: GameOption): Promise<void> {
  if (game.id === "dice-roll-duel") {
    await runDiceDuel(channel, game.label);
    return;
  }
  if (game.id === "red-light-green-light") {
    await runTrafficGame(channel, game.label);
    return;
  }

  const challenge = createChallenge(game.id, guild);
  if (challenge.kind === "choices") {
    await runChoiceGame(channel, game.label, challenge);
  } else if (challenge.kind === "memory") {
    await runMemoryGame(channel, game.label, challenge);
  } else if (challenge.kind === "answer") {
    const answers = new Set(challenge.answers.map(normalizeAnswer));
    await runAnswerGame(channel, game.label, challenge.prompt, (answer) => answers.has(normalizeAnswer(answer)));
  } else if (challenge.kind === "validate") {
    await runAnswerGame(channel, game.label, challenge.prompt, challenge.test);
  }
}

export async function handleGameDropInteraction(interaction: StringSelectMenuInteraction): Promise<void> {
  const [gameId] = interaction.values;
  const game = gameOptions.find((option) => option.id === gameId);
  const channel = interaction.channel;
  const createdAt = Number(interaction.customId.split(":")[1]);
  if (!game || !channel || channel.type !== ChannelType.GuildText || !interaction.guild) {
    await interaction.reply({ content: "This game drop is unavailable.", ephemeral: true });
    return;
  }
  if (!Number.isFinite(createdAt) || Date.now() - createdAt >= DROP_INTERVAL_MS) {
    await interaction.reply({ content: "This game menu has expired. Wait for the next drop!", ephemeral: true });
    return;
  }
  if (consumedDrops.has(interaction.message.id)) {
    await interaction.reply({ content: "Someone already picked a game from this drop.", ephemeral: true });
    return;
  }
  if (activeGameChannels.has(channel.id)) {
    await interaction.reply({ content: "A game is already running in this channel.", ephemeral: true });
    return;
  }

  consumedDrops.add(interaction.message.id);
  activeGameChannels.add(channel.id);
  try {
    await interaction.update({
      embeds: [formatDropMessage(channel.id).setDescription(`🎮 **${game.label}** was selected by <@${interaction.user.id}>. Get ready!`)],
      components: [],
    });
    await playGame(channel as TextChannel, interaction.guild, game);
  } catch (error) {
    logger.error({ err: error, guildId: interaction.guild.id, channelId: channel.id, gameId }, "Game drop round failed");
    await channel.send("The game could not start. Please try again on the next drop.").catch(() => {});
  } finally {
    activeGameChannels.delete(channel.id);
    setTimeout(() => consumedDrops.delete(interaction.message.id), DROP_INTERVAL_MS).unref();
  }
}