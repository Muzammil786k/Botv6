import { EmbedBuilder, type Message, type TextChannel } from "discord.js";
import { premiumColors, premiumMessagePayload } from "./presentation";
import { requireGameChannel } from "./gameChannel";
import { awardGameCredits } from "./credits";

const ROUND_TIME_MS = 30_000;
const EXISTING_GAME_REWARD = 200;
const NEW_GAME_REWARD = 100;
const GAME_EMOJIS = {
  capital: "<:world:1563228194247802882>",
  celebrity: "<:trophy:1558393071224365102>",
  letter: "<:reaction:1558393068254666785>",
  trivia: "<:world:1563228194247802882>",
  math: "<:reward:1558393075829702726>",
  number: "<:reaction:1558393068254666785>",
  trophy: "<:trophy:1558393071224365102>",
  time: "<:time:1558393079851917372>",
  reward: "<:reward:1558393075829702726>",
  credits: "<:credits:1558505663531851933>",
} as const;

type GameType = "capital" | "celebrity" | "letter" | "trivia" | "math" | "number";

interface Round {
  type: GameType;
  channelId: string;
  prompt: string;
  answers: Set<string>;
  reward: number;
  timer: NodeJS.Timeout;
}

interface CapitalQuestion {
  country: string;
  capital: string;
  aliases?: string[];
}

interface CelebrityQuestion {
  name: string;
  clues: string;
}

interface LetterQuestion {
  letter: string;
  theme: string;
  answers: string[];
}

interface TriviaQuestion {
  question: string;
  answer: string;
  aliases?: string[];
}

const CAPITAL_QUESTIONS: CapitalQuestion[] = [
  { country: "France", capital: "Paris" },
  { country: "Japan", capital: "Tokyo" },
  { country: "Brazil", capital: "Brasilia", aliases: ["Brasília"] },
  { country: "Canada", capital: "Ottawa" },
  { country: "Egypt", capital: "Cairo" },
  { country: "Germany", capital: "Berlin" },
  { country: "India", capital: "New Delhi", aliases: ["NewDelhi"] },
  { country: "Italy", capital: "Rome" },
  { country: "Kenya", capital: "Nairobi" },
  { country: "Mexico", capital: "Mexico City", aliases: ["MexicoCity"] },
  { country: "Spain", capital: "Madrid" },
  { country: "Australia", capital: "Canberra" },
  { country: "South Korea", capital: "Seoul" },
  { country: "Turkey", capital: "Ankara" },
  { country: "United Kingdom", capital: "London" },
];

const CELEBRITY_QUESTIONS: CelebrityQuestion[] = [
  { name: "Taylor Swift", clues: "I am a singer-songwriter known for Eras, Red, and Love Story." },
  { name: "Leonardo DiCaprio", clues: "I am an actor who starred in Titanic, Inception, and The Revenant." },
  { name: "Beyonce", clues: "I am a singer known for Lemonade, Halo, and a career with Destiny's Child." },
  { name: "Dwayne Johnson", clues: "I am an actor and former wrestler known as The Rock." },
  { name: "Adele", clues: "I am a singer known for Hello, Someone Like You, and 21." },
  { name: "Tom Hanks", clues: "I am an actor known for Forrest Gump, Cast Away, and Toy Story." },
  { name: "Rihanna", clues: "I am a singer known for Umbrella, Diamonds, and Fenty." },
  { name: "Shah Rukh Khan", clues: "I am an Indian actor known as the King of Bollywood." },
  { name: "Cristiano Ronaldo", clues: "I am a Portuguese footballer known for many Champions League goals." },
  { name: "Lady Gaga", clues: "I am a singer and actor known for Poker Face and A Star Is Born." },
];

const LETTER_QUESTIONS: LetterQuestion[] = [
  { letter: "K", theme: "fruits or vegetables", answers: ["kiwi", "kale", "kumquat"] },
  { letter: "B", theme: "countries", answers: ["brazil", "belgium", "bhutan", "bahamas", "bahrain", "bangladesh", "barbados", "belarus", "belize", "benin", "bolivia", "botswana", "brunei", "bulgaria", "burkina faso", "burundi"] },
  { letter: "C", theme: "cities", answers: ["cairo", "chicago", "chennai", "chicago", "cape town", "canberra", "casablanca", "copenhagen"] },
  { letter: "M", theme: "names", answers: ["maria", "michael", "maya", "mohammed", "mason", "meera", "mia", "marco"] },
  { letter: "T", theme: "objects", answers: ["table", "telephone", "towel", "television", "telescope", "toothbrush"] },
  { letter: "S", theme: "fruits or vegetables", answers: ["strawberry", "spinach", "squash", "sweet potato"] },
  { letter: "P", theme: "countries", answers: ["pakistan", "panama", "peru", "poland", "portugal", "paraguay", "palau", "palestine", "papua new guinea", "philippines"] },
  { letter: "L", theme: "cities", answers: ["london", "lahore", "lisbon", "lima", "lucknow", "los angeles", "liverpool"] },
];

const TRIVIA_QUESTIONS: TriviaQuestion[] = [
  { question: "Which planet is known as the Red Planet?", answer: "Mars" },
  { question: "How many continents are there on Earth?", answer: "7", aliases: ["seven"] },
  { question: "What is the largest ocean on Earth?", answer: "Pacific Ocean", aliases: ["pacific"] },
  { question: "Who painted the Mona Lisa?", answer: "Leonardo da Vinci", aliases: ["leonardo", "da vinci"] },
  { question: "What is the chemical symbol for gold?", answer: "Au" },
  { question: "Which animal is known as the King of the Jungle?", answer: "Lion" },
  { question: "What is the fastest land animal?", answer: "Cheetah" },
  { question: "How many days are in a leap year?", answer: "366" },
  { question: "What is the capital city of Canada?", answer: "Ottawa" },
  { question: "Which gas do plants absorb from the atmosphere?", answer: "Carbon dioxide", aliases: ["co2", "carbon"] },
  { question: "What is the hardest natural substance?", answer: "Diamond" },
  { question: "Which instrument has black and white keys?", answer: "Piano" },
  { question: "What is the smallest prime number?", answer: "2", aliases: ["two"] },
  { question: "Which country is famous for the Great Pyramids of Giza?", answer: "Egypt" },
  { question: "What is H2O commonly called?", answer: "Water" },
  { question: "Which sport uses a shuttlecock?", answer: "Badminton" },
  { question: "What is the largest mammal in the world?", answer: "Blue whale", aliases: ["bluewhale"] },
  { question: "Who wrote Romeo and Juliet?", answer: "William Shakespeare", aliases: ["shakespeare"] },
  { question: "How many sides does a hexagon have?", answer: "6", aliases: ["six"] },
  { question: "Which language has the most native speakers worldwide?", answer: "Mandarin", aliases: ["mandarin chinese", "chinese"] },
  { question: "What is the currency of Japan?", answer: "Yen" },
  { question: "Which organ pumps blood around the human body?", answer: "Heart" },
  { question: "What is the tallest mountain above sea level?", answer: "Mount Everest", aliases: ["everest"] },
  { question: "Which bird is often associated with delivering messages?", answer: "Pigeon" },
  { question: "What is the freezing point of water in Celsius?", answer: "0", aliases: ["zero"] },
];

const rounds = new Map<string, Round>();

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ");
}

function randomItem<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

function gameLabel(type: GameType): string {
  const labels: Record<GameType, string> = {
    capital: "Country Capitals",
    celebrity: "Celebrity Identify",
    letter: "Letter + Theme",
    trivia: "Trivia Quiz",
    math: "Math Challenge",
    number: "Guess the Number",
  };
  return labels[type];
}

function parseGameType(value: string | undefined): GameType | null {
  const normalized = value?.toLowerCase();
  if (normalized === "capital" || normalized === "capitals") return "capital";
  if (normalized === "celebrity" || normalized === "celeb") return "celebrity";
  if (normalized === "letter" || normalized === "theme") return "letter";
  if (normalized === "trivia" || normalized === "quiz") return "trivia";
  if (normalized === "math" || normalized === "mathematics") return "math";
  if (normalized === "number" || normalized === "guess") return "number";
  return null;
}

function createQuestion(type: GameType): { prompt: string; answers: Set<string>; reward: number } {
  if (type === "capital") {
    const question = randomItem(CAPITAL_QUESTIONS);
    return {
      prompt: `What is the capital of **${question.country}**?`,
      answers: new Set([normalize(question.capital), ...(question.aliases ?? []).map(normalize)]),
      reward: EXISTING_GAME_REWARD,
    };
  }

  if (type === "celebrity") {
    const question = randomItem(CELEBRITY_QUESTIONS);
    return {
      prompt: `Who am I?\n${question.clues}`,
      answers: new Set([normalize(question.name)]),
      reward: EXISTING_GAME_REWARD,
    };
  }

  if (type === "letter") {
    const question = randomItem(LETTER_QUESTIONS);
    return {
      prompt: `**LETTER: ${question.letter}**\n**THEME: ${question.theme.toUpperCase()}**\nName something in this theme that starts with **${question.letter}**.`,
      answers: new Set(question.answers.map(normalize)),
      reward: EXISTING_GAME_REWARD,
    };
  }

  if (type === "trivia") {
    const question = randomItem(TRIVIA_QUESTIONS);
    return {
      prompt: question.question,
      answers: new Set([normalize(question.answer), ...(question.aliases ?? []).map(normalize)]),
      reward: NEW_GAME_REWARD,
    };
  }

  if (type === "math") {
    const first = Math.floor(Math.random() * 41) + 10;
    const second = Math.floor(Math.random() * 9) + 2;
    const operation = randomItem(["+", "-", "×"] as const);
    const answer = operation === "+" ? first + second : operation === "-" ? first - second : first * second;
    return {
      prompt: `Solve: **${first} ${operation} ${second} = ?**`,
      answers: new Set([String(answer)]),
      reward: NEW_GAME_REWARD,
    };
  }

  const answer = Math.floor(Math.random() * 50) + 1;
  return {
    prompt: "Guess the secret number between **1 and 50**.",
    answers: new Set([String(answer)]),
    reward: NEW_GAME_REWARD,
  };
}

async function endRound(
  guildId: string,
  channel: TextChannel,
  round: Round,
  winnerId?: string,
): Promise<void> {
  if (rounds.get(guildId) !== round) return;
  rounds.delete(guildId);
  clearTimeout(round.timer);

  if (!winnerId) {
    await channel.send(premiumMessagePayload(`${GAME_EMOJIS.time} Time's up! Nobody solved the **${gameLabel(round.type)}** round.`, channel.client.user));
    return;
  }

  await awardGameCredits(guildId, winnerId, round.reward);
  await channel.send(premiumMessagePayload(`${GAME_EMOJIS.reward} <@${winnerId}> solved **${gameLabel(round.type)}** first and won ${GAME_EMOJIS.credits} **${round.reward} credits**!`, channel.client.user));
}

export async function handleCreditGameCommand(message: Message, args: string[]): Promise<void> {
  if (!message.guild || !(await requireGameChannel(message))) return;
  const type = parseGameType(args[0]);
  if (!type) {
    await message.reply("Usage: `!games capital|celebrity|letter|trivia|math|number`.");
    return;
  }
  if (rounds.has(message.guild.id)) {
    await message.reply("❌ A credit game is already active in this server.");
    return;
  }

  const question = createQuestion(type);
  const channel = message.channel as TextChannel;
  const round = {
    type,
    channelId: channel.id,
    prompt: question.prompt,
    answers: question.answers,
    reward: question.reward,
    timer: undefined as unknown as NodeJS.Timeout,
  } satisfies Round;
  round.timer = setTimeout(() => {
    void endRound(message.guild!.id, channel, round);
  }, ROUND_TIME_MS);
  rounds.set(message.guild.id, round);

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(premiumColors.brand)
        .setTitle(`${GAME_EMOJIS[type]} ${gameLabel(type)}`)
        .setDescription(`${round.prompt}\n\n${GAME_EMOJIS.trophy} First correct answer wins ${GAME_EMOJIS.credits} **${round.reward} credits**.\n${GAME_EMOJIS.time} You have **30 seconds**!`),
    ],
  });
}

export async function handleCreditGameAnswer(message: Message): Promise<void> {
  if (!message.guild || message.author.bot || message.content.trim().startsWith("!")) return;
  const round = rounds.get(message.guild.id);
  if (!round || round.channelId !== message.channel.id) return;
  if (!round.answers.has(normalize(message.content))) return;
  await endRound(message.guild.id, message.channel as TextChannel, round, message.author.id);
}