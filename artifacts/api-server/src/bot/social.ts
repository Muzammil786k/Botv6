import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type ButtonInteraction,
  type Message,
} from "discord.js";
import { logger } from "../lib/logger";
import { canUseSocialCommands, canUseSocialCommandsForMember } from "./socialRole";

interface SocialAction {
  description: string;
  title: string;
  help: string;
  gifCategory: string;
  render: (actor: string, target: string, targetId: string) => string;
}

function seededScore(seed: string, min: number, max: number): number {
  let hash = 2166136261;
  for (const character of seed) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  }
  return min + ((hash >>> 0) % (max - min + 1));
}

function dailyScore(kind: string, targetId: string, min: number, max: number): number {
  const day = new Date().toISOString().slice(0, 10);
  return seededScore(`${kind}:${targetId}:${day}`, min, max);
}

export const SOCIAL_ACTIONS = {
  hug: {
    description: "Give a member a warm hug.",
    title: "🫂 Hug!",
    help: "Send someone a warm hug.",
    gifCategory: "hug",
    render: (actor, target) => `${actor} gives ${target} a big, warm hug!`,
  },
  kiss: {
    description: "Send a friendly kiss to a member.",
    title: "😘 Friendly kiss!",
    help: "Send someone a friendly, non-romantic kiss.",
    gifCategory: "kiss",
    render: (actor, target) => `${actor} sends ${target} a friendly kiss!`,
  },
  bite: {
    description: "Playfully nibble a member.",
    title: "😬 Playful bite!",
    help: "Give someone a playful cartoon nibble.",
    gifCategory: "bite",
    render: (actor, target) => `${actor} gives ${target} a silly cartoon nibble!`,
  },
  kill: {
    description: "Pretend to defeat a member in a silly game.",
    title: "🎮 Game over!",
    help: "Pretend to defeat someone in a harmless game-style showdown.",
    gifCategory: "shoot",
    render: (actor, target) => `${actor} defeats ${target} in a silly game-style showdown. Respawn in 3… 2… 1!`,
  },
  fight: {
    description: "Have a playful cartoon sparring match with a member.",
    title: "🥊 Playful spar!",
    help: "Start a silly, harmless cartoon sparring match.",
    gifCategory: "punch",
    render: (actor, target) => `${actor} starts a goofy cartoon spar with ${target}. Winner gets bragging rights!`,
  },
  slap: {
    description: "Give a member a light cartoon-style slap.",
    title: "🖐️ Cartoon slap!",
    help: "Give someone a harmless, cartoon-style slap.",
    gifCategory: "slap",
    render: (actor, target) => `${actor} gives ${target} a harmless cartoon-style slap!`,
  },
  pat: {
    description: "Give a member a gentle head pat.",
    title: "🐾 Head pat!",
    help: "Give someone a gentle head pat.",
    gifCategory: "pat",
    render: (actor, target) => `${actor} gives ${target} a gentle head pat.`,
  },
  cuddle: {
    description: "Cuddle up with a member.",
    title: "🧸 Cuddle!",
    help: "Share a cozy cuddle with someone.",
    gifCategory: "cuddle",
    render: (actor, target) => `${actor} cuddles up with ${target}. Cozy mode: activated!`,
  },
  highfive: {
    description: "Give a member a high-five.",
    title: "🙌 High-five!",
    help: "Give someone a high-five.",
    gifCategory: "highfive",
    render: (actor, target) => `${actor} gives ${target} a high-five!`,
  },
  wave: {
    description: "Wave hello to a member.",
    title: "👋 Hello!",
    help: "Wave hello to someone.",
    gifCategory: "wave",
    render: (actor, target) => `${actor} waves hello to ${target}!`,
  },
  poke: {
    description: "Playfully poke a member.",
    title: "👉 Poke!",
    help: "Playfully poke someone to get their attention.",
    gifCategory: "poke",
    render: (actor, target) => `${actor} pokes ${target}. Poke!`,
  },
  bonk: {
    description: "Give a member a harmless cartoon bonk.",
    title: "🔨 Bonk!",
    help: "Give someone a harmless cartoon bonk.",
    gifCategory: "bonk",
    render: (actor, target) => `${actor} gives ${target} a harmless cartoon bonk!`,
  },
  boop: {
    description: "Give a member a nose boop.",
    title: "👉 Boop!",
    help: "Give someone a friendly nose boop.",
    gifCategory: "boop",
    render: (actor, target) => `${actor} boops ${target}'s nose! Boop!`,
  },
  dance: {
    description: "Do a little dance for a member.",
    title: "💃 Dance!",
    help: "Do a little dance for someone.",
    gifCategory: "dance",
    render: (actor, target) => `${actor} does a little dance for ${target}!`,
  },
  smile: {
    description: "Send a friendly smile to a member.",
    title: "😊 Smile!",
    help: "Share a friendly smile with someone.",
    gifCategory: "smile",
    render: (actor, target) => `${actor} gives ${target} a big friendly smile!`,
  },
  cheer: {
    description: "Cheer a member on.",
    title: "📣 Cheer!",
    help: "Cheer someone on and brighten their day.",
    gifCategory: "happy",
    render: (actor, target) => `${actor} cheers ${target} on! You’ve got this!`,
  },
  thanks: {
    description: "Thank a member.",
    title: "💛 Thanks!",
    help: "Send someone a quick thank-you.",
    gifCategory: "highfive",
    render: (actor, target) => `${actor} thanks ${target}!`,
  },
  comfort: {
    description: "Comfort a member.",
    title: "🫂 Comfort",
    help: "Send someone a little comfort.",
    gifCategory: "hug",
    render: (actor, target) => `${actor} is here for ${target}. Sending comfort and a hug.`,
  },
  celebrate: {
    description: "Celebrate with a member.",
    title: "🎉 Celebrate!",
    help: "Celebrate a win or good news with someone.",
    gifCategory: "dance",
    render: (actor, target) => `${actor} celebrates with ${target}!`,
  },
  handhold: {
    description: "Hold hands with a member.",
    title: "🤝 Hand-hold!",
    help: "Hold hands with someone.",
    gifCategory: "handhold",
    render: (actor, target) => `${actor} holds hands with ${target}.`,
  },
  punch: {
    description: "Throw a harmless cartoon punch at a member.",
    title: "🥊 Cartoon punch!",
    help: "Throw someone a harmless, cartoon-style punch.",
    gifCategory: "punch",
    render: (actor, target) => `${actor} throws a harmless cartoon punch at ${target} — just a game!`,
  },
  blush: {
    description: "Send a blushing anime reaction to a member.",
    title: "😊 Blush!",
    help: "Share a blushing anime reaction with someone.",
    gifCategory: "blush",
    render: (actor, target) => `${actor} blushes at ${target}!`,
  },
  cry: {
    description: "Share a dramatic anime cry with a member.",
    title: "😭 Cry!",
    help: "Share an over-the-top anime cry with someone.",
    gifCategory: "cry",
    render: (actor, target) => `${actor} and ${target} share a dramatic anime cry.`,
  },
  feed: {
    description: "Offer a member a snack.",
    title: "🍡 Snack time!",
    help: "Offer someone a tasty snack.",
    gifCategory: "feed",
    render: (actor, target) => `${actor} offers ${target} a tasty snack!`,
  },
  cartoonkick: {
    description: "Give a member a harmless cartoon kick.",
    title: "🦵 Cartoon kick!",
    help: "Give someone a harmless, cartoon-style kick.",
    gifCategory: "kick",
    render: (actor, target) => `${actor} gives ${target} a harmless cartoon kick — just for fun!`,
  },
  laugh: {
    description: "Laugh along with a member.",
    title: "😂 Laugh!",
    help: "Share a laugh with someone.",
    gifCategory: "laugh",
    render: (actor, target) => `${actor} laughs along with ${target}!`,
  },
  nom: {
    description: "Share a playful snack reaction with a member.",
    title: "😋 Nom!",
    help: "Share a silly anime snack reaction.",
    gifCategory: "nom",
    render: (actor, target) => `${actor} shares a snack break with ${target}. Nom nom!`,
  },
  pout: {
    description: "Send a playful pout to a member.",
    title: "😗 Pout!",
    help: "Send someone a cute, playful pout.",
    gifCategory: "pout",
    render: (actor, target) => `${actor} gives ${target} a playful pout!`,
  },
  shrug: {
    description: "Share a shrug reaction with a member.",
    title: "🤷 Shrug!",
    help: "Share a shrug reaction with someone.",
    gifCategory: "shrug",
    render: (actor, target) => `${actor} shrugs with ${target}.`,
  },
  think: {
    description: "Think through something with a member.",
    title: "🤔 Thinking...",
    help: "Share a thoughtful anime reaction.",
    gifCategory: "think",
    render: (actor, target) => `${actor} thinks this one over with ${target}.`,
  },
  wink: {
    description: "Send a friendly wink to a member.",
    title: "😉 Wink!",
    help: "Send someone a friendly wink.",
    gifCategory: "wink",
    render: (actor, target) => `${actor} gives ${target} a friendly wink!`,
  },
  clap: {
    description: "Give a member a round of applause.",
    title: "👏 Applause!",
    help: "Give someone a round of applause.",
    gifCategory: "clap",
    render: (actor, target) => `${actor} gives ${target} a big round of applause!`,
  },
  aura: {
    description: "Check a member's daily aura score.",
    title: "✨ Aura check",
    help: "See someone's daily aura points. The score changes each day.",
    gifCategory: "smug",
    render: (_actor, target, targetId) => {
      const score = dailyScore("aura", targetId, -1000, 1000);
      const points = `${score >= 0 ? "+" : ""}${score.toLocaleString()}`;
      const verdict =
        score >= 750
          ? "Unstoppable main-character energy!"
          : score >= 0
            ? "Aura is looking good."
            : "A little aura debt—comeback loading!";
      return `**${target}** has **${points} aura** today. ${verdict}`;
    },
  },
  rizz: {
    description: "Get a member's daily rizz score.",
    title: "😎 Rizz check",
    help: "Get someone's daily charm score, out of 100.",
    gifCategory: "wink",
    render: (_actor, target, targetId) => {
      const score = dailyScore("rizz", targetId, 0, 100);
      const verdict =
        score >= 85
          ? "Certified smooth."
          : score >= 60
            ? "The charm is working."
            : score >= 30
              ? "Rizz is loading..."
              : "Quiet confidence still counts.";
      return `**${target}** has **${score}/100 rizz** today. ${verdict}`;
    },
  },
  vibecheck: {
    description: "Run a playful daily vibe check on a member.",
    title: "🌈 Vibe check",
    help: "Check someone's daily vibe score, out of 100.",
    gifCategory: "smile",
    render: (_actor, target, targetId) => {
      const score = dailyScore("vibe", targetId, 0, 100);
      const verdict =
        score >= 80
          ? "Excellent vibes."
          : score >= 55
            ? "Good energy all around."
            : score >= 30
              ? "A calm, low-key vibe."
              : "Recharge mode—be kind to yourself.";
      return `**${target}** scores **${score}/100** on today's vibe check. ${verdict}`;
    },
  },
  rate: {
    description: "Give a member a playful daily rating.",
    title: "⭐ Daily rating",
    help: "Give someone a friendly, for-fun rating out of 10.",
    gifCategory: "happy",
    render: (_actor, target, targetId) => {
      const score = dailyScore("rate", targetId, 0, 100);
      return `Today's totally-for-fun rating for **${target}**: **${(score / 10).toFixed(1)}/10** ⭐`;
    },
  },
  iq: {
    description: "Get a member's playful daily IQ score.",
    title: "🧠 IQ check",
    help: "Show someone's daily, for-fun IQ score out of 200.",
    gifCategory: "think",
    render: (_actor, target, targetId) => {
      const score = dailyScore("iq", targetId, 0, 200);
      return `**${target}** has **${score} IQ** today. Just for fun!`;
    },
  },
  compliment: {
    description: "Send a member a friendly compliment.",
    title: "💛 A little appreciation",
    help: "Send someone a friendly compliment.",
    gifCategory: "happy",
    render: (_actor, target, targetId) => {
      const compliments = [
        "you make this server a better place.",
        "your energy is always appreciated.",
        "you have a knack for making people smile.",
        "you are more awesome than you realize.",
        "your kindness does not go unnoticed.",
        "you bring great vibes wherever you go.",
        "you are a genuinely fun person to have around.",
        "you deserve a little appreciation today.",
      ];
      const index = dailyScore("compliment", targetId, 0, compliments.length - 1);
      return `**${target}**, ${compliments[index]}`;
    },
  },
  roast: {
    description: "Give a member a gentle, playful roast.",
    title: "🔥 Friendly roast",
    help: "Give someone a light, non-personal roast. Just jokes, all love.",
    gifCategory: "facepalm",
    render: (_actor, target, targetId) => {
      const roasts = [
        "has the confidence of a Wi-Fi router with one bar.",
        "could lose a staring contest to a loading screen.",
        "has main-character energy, but the tutorial is still loading.",
        "is one browser tab away from forgetting the original plan.",
        "could turn a quick question into a full side quest.",
        "brings so much chaos even the group chat needs a map.",
        "has the timing of a software update at 1% battery.",
        "could make a two-option poll feel like a final exam.",
      ];
      const index = dailyScore("roast", targetId, 0, roasts.length - 1);
      return `A friendly roast for **${target}**: ${roasts[index]} All jokes, all love.`;
    },
  },
} satisfies Record<string, SocialAction>;

export type SocialActionName = keyof typeof SOCIAL_ACTIONS;
export const SOCIAL_ACTION_NAMES = Object.keys(SOCIAL_ACTIONS) as SocialActionName[];
const SCORE_ACTIONS: ReadonlySet<SocialActionName> = new Set([
  "aura",
  "rizz",
  "vibecheck",
  "rate",
  "iq",
]);

function buildScoreCard(
  actionName: SocialActionName,
  targetName: string,
  targetId: string,
  avatarUrl: string,
  gifUrl?: string,
): EmbedBuilder {
  let score: number;
  let minimum: number;
  let maximum: number;
  let scoreLabel: string;
  let reading: string;

  switch (actionName) {
    case "aura": {
      score = dailyScore("aura", targetId, -1000, 1000);
      minimum = -1000;
      maximum = 1000;
      scoreLabel = `${score >= 0 ? "+" : ""}${score.toLocaleString()} aura`;
      reading = score >= 750
        ? "Unstoppable main-character energy."
        : score >= 0
          ? "Aura is looking good."
          : "A little aura debt. Comeback loading!";
      break;
    }
    case "rizz": {
      score = dailyScore("rizz", targetId, 0, 100);
      minimum = 0;
      maximum = 100;
      scoreLabel = `${score}/100`;
      reading = score >= 85
        ? "Certified smooth."
        : score >= 60
          ? "The charm is working."
          : score >= 30
            ? "Rizz is loading..."
            : "Quiet confidence still counts.";
      break;
    }
    case "vibecheck": {
      score = dailyScore("vibe", targetId, 0, 100);
      minimum = 0;
      maximum = 100;
      scoreLabel = `${score}/100`;
      reading = score >= 80
        ? "Excellent vibes."
        : score >= 55
          ? "Good energy all around."
          : score >= 30
            ? "A calm, low-key vibe."
            : "Recharge mode. Be kind to yourself.";
      break;
    }
    case "rate": {
      score = dailyScore("rate", targetId, 0, 100);
      minimum = 0;
      maximum = 100;
      scoreLabel = `${(score / 10).toFixed(1)}/10`;
      reading = "A totally-for-fun daily rating.";
      break;
    }
    case "iq": {
      score = dailyScore("iq", targetId, 0, 200);
      minimum = 0;
      maximum = 200;
      scoreLabel = `${score} IQ`;
      reading = score >= 160
        ? "Big-brain energy."
        : score >= 110
          ? "Sharp thinking today."
          : score >= 70
            ? "Steady everyday smarts."
            : "Brain is buffering—try again tomorrow.";
      break;
    }
    default:
      throw new Error(`No score card is defined for ${actionName}`);
  }

  const filledBlocks = Math.round(((score - minimum) / (maximum - minimum)) * 12);
  const meter = `${"▰".repeat(filledBlocks)}${"▱".repeat(12 - filledBlocks)}`;

  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setAuthor({ name: targetName, iconURL: avatarUrl })
    .setDescription(`Today's reading for **${targetName}**`)
    .addFields(
      { name: "SCORE", value: `**${scoreLabel}**\n${meter}`, inline: true },
      { name: "READING", value: reading, inline: true },
    )
    .setTimestamp();

  if (gifUrl) embed.setImage(gifUrl);
  return embed;
}

function auraMood(score: number): { color: number; title: string; reading: string; gifCategory: string } {
  if (score >= 750) {
    return {
      color: 0xf1c40f,
      title: "LEGENDARY AURA",
      reading: "Unstoppable main-character energy. The room changes when you arrive.",
      gifCategory: "smug",
    };
  }
  if (score >= 250) {
    return {
      color: 0x9b59b6,
      title: "RADIANT AURA",
      reading: "Your energy is glowing today. Keep being iconic.",
      gifCategory: "happy",
    };
  }
  if (score >= 0) {
    return {
      color: 0x2ecc71,
      title: "GOOD VIBRATIONS",
      reading: "Aura is looking good. You're bringing positive energy.",
      gifCategory: "smile",
    };
  }
  if (score >= -500) {
    return {
      color: 0x3498db,
      title: "MYSTERIOUS ENERGY",
      reading: "A quiet, mysterious aura today. Your comeback arc is loading.",
      gifCategory: "think",
    };
  }
  return {
    color: 0x5865f2,
    title: "AURA RECHARGE",
    reading: "Even legends need a recharge. Take it easy; tomorrow is a fresh scan.",
    gifCategory: "cry",
  };
}

function buildAuraCard(
  targetName: string,
  score: number,
  avatarUrl: string,
  gifUrl?: string,
): EmbedBuilder {
  const mood = auraMood(score);
  const filledBlocks = Math.round(((score + 1000) / 2000) * 8);
  const meter = `${"▰".repeat(filledBlocks)}${"▱".repeat(8 - filledBlocks)}`;
  const embed = new EmbedBuilder()
    .setColor(mood.color)
    .setAuthor({ name: `${targetName}'s daily aura`, iconURL: avatarUrl })
    .setDescription(
      `**${score >= 0 ? "+" : ""}${score.toLocaleString()} aura**  ${meter}\n${mood.reading}`,
    );

  if (gifUrl) embed.setImage(gifUrl);

  return embed;
}

function safeDisplayName(name: string): string {
  return name.replace(/@/g, "@\u200b");
}

const SOCIAL_BACK_PREFIX = "social:back:";
const NON_INTERACTION_ACTIONS: ReadonlySet<string> = new Set([
  "aura",
  "rate",
  "rizz",
  "vibecheck",
  "iq",
  "roast",
  "compliment",
]);
const BACK_LABELS: Partial<Record<SocialActionName, string>> = {
  hug: "Hug back 🫂",
  fight: "Fight back 🥊",
  kiss: "Kiss back 😘",
  pat: "Pat back 🐾",
  slap: "Slap back 🖐️",
  cuddle: "Cuddle back 🧸",
  highfive: "High-five back 🙌",
  wave: "Wave back 👋",
  poke: "Poke back 👉",
  boop: "Boop back 👉",
  bonk: "Bonk back 🔨",
};
const BACK_NOUNS: Partial<Record<SocialActionName, string>> = {
  hug: "hug",
  fight: "fight",
  kiss: "kiss",
  pat: "pat",
  slap: "slap",
  cuddle: "cuddle",
  highfive: "high-five",
  wave: "wave",
  poke: "poke",
  boop: "boop",
  bonk: "bonk",
};

function isSocialActionName(name: string): name is SocialActionName {
  return Object.prototype.hasOwnProperty.call(SOCIAL_ACTIONS, name);
}

function supportsBackButton(actionName: string): boolean {
  return isSocialActionName(actionName) && !NON_INTERACTION_ACTIONS.has(actionName);
}

// Message IDs whose "back" button is currently being processed, to prevent double-clicks.
const pendingBackMessageIds = new Set<string>();

interface NekoGifResult {
  anime_name?: unknown;
  url?: unknown;
}

interface NekoGifResponse {
  results?: NekoGifResult[];
}

const GIFS_PER_REQUEST = 20;
const GIF_POOL_BATCHES = 4;
const GIF_POOL_REFILL_THRESHOLD = 5;
const RECENT_GIF_HISTORY = 100;
const recentGifUrlsByCategory = new Map<string, Set<string>>();
const gifPoolsByCategory = new Map<string, (NekoGifResult & { url: string })[]>();
const gifPoolLoadsByCategory = new Map<string, Promise<void>>();

async function refillGifPool(category: string): Promise<void> {
  const pool = gifPoolsByCategory.get(category) ?? [];
  if (pool.length > GIF_POOL_REFILL_THRESHOLD) return;

  const pendingLoad = gifPoolLoadsByCategory.get(category);
  if (pendingLoad) {
    await pendingLoad;
    return;
  }

  const load = (async () => {
    const batches = await Promise.allSettled(
      Array.from({ length: GIF_POOL_BATCHES }, async () => {
        const endpoint = new URL(`https://nekos.best/api/v2/${category}`);
        endpoint.searchParams.set("amount", String(GIFS_PER_REQUEST));
        const response = await fetch(endpoint, {
          headers: {
            Accept: "application/json",
            "User-Agent": "Mainz (https://github.com/Muzammil786k/Mainz)",
          },
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) {
          throw new Error(`Anime GIF service returned HTTP ${response.status} for ${category}`);
        }
        const data = (await response.json()) as NekoGifResponse;
        return data.results ?? [];
      }),
    );

    const knownUrls = new Set(pool.map((gif) => gif.url));
    for (const batch of batches) {
      if (batch.status !== "fulfilled") continue;
      for (const result of batch.value) {
        if (typeof result.url !== "string" || knownUrls.has(result.url)) continue;
        try {
          const url = new URL(result.url);
          if (
            url.protocol !== "https:" ||
            (url.hostname !== "nekos.best" && !url.hostname.endsWith(".nekos.best"))
          ) continue;
          pool.push({ ...result, url: url.href });
          knownUrls.add(url.href);
        } catch {
          // Ignore malformed URLs returned by the upstream GIF service.
        }
      }
    }
    gifPoolsByCategory.set(category, pool);
  })();

  gifPoolLoadsByCategory.set(category, load);
  try {
    await load;
  } finally {
    if (gifPoolLoadsByCategory.get(category) === load) {
      gifPoolLoadsByCategory.delete(category);
    }
  }
}

async function fetchAnimeGif(category: string): Promise<{ url: string; animeName?: string } | null> {
  try {
    await refillGifPool(category);
    const pool = gifPoolsByCategory.get(category) ?? [];
    const recent = recentGifUrlsByCategory.get(category) ?? new Set<string>();
    const freshCandidates = pool.filter((result) => !recent.has(result.url));
    const candidates = freshCandidates.length > 0 ? freshCandidates : pool;
    if (candidates.length === 0) return null;

    const result = candidates[Math.floor(Math.random() * candidates.length)];
    if (!result) return null;

    const poolIndex = pool.findIndex((gif) => gif.url === result.url);
    if (poolIndex >= 0) pool.splice(poolIndex, 1);

    recent.add(result.url);
    while (recent.size > RECENT_GIF_HISTORY) {
      const oldestUrl = recent.values().next().value;
      if (!oldestUrl) break;
      recent.delete(oldestUrl);
    }
    recentGifUrlsByCategory.set(category, recent);

    return {
      url: result.url,
      animeName: typeof result.anime_name === "string" ? result.anime_name : undefined,
    };
  } catch (error) {
    logger.warn({ err: error, category }, "Could not fetch anime GIF");
    return null;
  }
}

async function replyWithSocialEmbed(
  message: Message,
  embed: EmbedBuilder,
  extraButtons: ButtonBuilder[] = [],
): Promise<void> {
  await message.reply({
    embeds: [embed],
    ...(extraButtons.length > 0
      ? { components: [new ActionRowBuilder<ButtonBuilder>().addComponents(...extraButtons)] }
      : {}),
    allowedMentions: { parse: [], repliedUser: false },
  });
}

export async function handleSocialAction(message: Message, actionName: SocialActionName): Promise<void> {
  if (!message.guild) return;
  if (!(await canUseSocialCommands(message))) return;

  const targetId =
    message.mentions.users.first()?.id ??
    message.content.trim().split(/\s+/)[1]?.match(/^\d{17,20}$/)?.[0];

  if (!targetId) {
    await message.reply(`❌ Mention a server member. Usage: \`!${actionName} @user\``);
    return;
  }

  const target =
    message.guild.members.cache.get(targetId) ??
    (await message.guild.members.fetch(targetId).catch(() => null));

  if (!target) {
    await message.reply("❌ I couldn’t find that member in this server.");
    return;
  }

  const action = SOCIAL_ACTIONS[actionName];
  if (SCORE_ACTIONS.has(actionName)) {
    const avatarUrl = target.user.displayAvatarURL({ size: 256 });
    if (actionName === "aura") {
      const score = dailyScore("aura", target.id, -1000, 1000);
      const mood = auraMood(score);
      const gif = await fetchAnimeGif(mood.gifCategory);
      await replyWithSocialEmbed(
        message,
        buildAuraCard(
          safeDisplayName(target.displayName),
          score,
          avatarUrl,
          gif?.url,
        ),
      );
      return;
    }

    const gif = await fetchAnimeGif(action.gifCategory);
    const embed = buildScoreCard(
      actionName,
      safeDisplayName(target.displayName),
      target.id,
      avatarUrl,
      gif?.url,
    );
    await replyWithSocialEmbed(message, embed);
    return;
  }

  const gif = await fetchAnimeGif(action.gifCategory);
  const actorName = safeDisplayName(message.member?.displayName ?? message.author.username);
  const targetName = safeDisplayName(target.displayName);
  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setDescription(action.render(actorName, targetName, target.id));

  if (gif) embed.setImage(gif.url);

  const extraButtons: ButtonBuilder[] = [];
  if (supportsBackButton(actionName) && target.id !== message.author.id && !target.user.bot) {
    const customId = `${SOCIAL_BACK_PREFIX}${actionName}:${message.author.id}:${target.id}`;
    if (customId.length <= 100) {
      extraButtons.push(
        new ButtonBuilder()
          .setCustomId(customId)
          .setLabel(BACK_LABELS[actionName] ?? "Send back")
          .setStyle(ButtonStyle.Primary),
      );
    }
  }

  await replyWithSocialEmbed(message, embed, extraButtons);
}

export async function handleSocialBackButton(interaction: ButtonInteraction): Promise<void> {
  const [actionName, originalActorId, originalTargetId] = interaction.customId
    .slice(SOCIAL_BACK_PREFIX.length)
    .split(":");

  try {
    if (!actionName || !originalActorId || !originalTargetId) {
      await interaction.reply({ content: "❌ This button is no longer valid.", ephemeral: true });
      return;
    }

    if (interaction.user.id !== originalTargetId) {
      const noun = isSocialActionName(actionName) ? (BACK_NOUNS[actionName] ?? "reaction") : "reaction";
      await interaction.reply({
        content: `Only the person who was targeted can send a ${noun} back.`,
        ephemeral: true,
      });
      return;
    }

    if (!isSocialActionName(actionName) || !supportsBackButton(actionName)) {
      await interaction.reply({ content: "❌ This action can't be sent back.", ephemeral: true });
      return;
    }

    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({ content: "❌ This button only works in a server.", ephemeral: true });
      return;
    }

    if (pendingBackMessageIds.has(interaction.message.id)) {
      await interaction.reply({ content: "⏳ That's already being sent back.", ephemeral: true });
      return;
    }
    pendingBackMessageIds.add(interaction.message.id);

    try {
      const [clicker, original] = await Promise.all([
        guild.members.cache.get(originalTargetId) ?? guild.members.fetch(originalTargetId).catch(() => null),
        guild.members.cache.get(originalActorId) ?? guild.members.fetch(originalActorId).catch(() => null),
      ]);
      if (!clicker || !original) {
        await interaction.reply({ content: "❌ I couldn’t find both members in this server.", ephemeral: true });
        return;
      }

      const canUseSocialCommands = await canUseSocialCommandsForMember(guild.id, clicker);
      if (canUseSocialCommands === undefined) {
        await interaction.reply({
          content: "❌ I couldn't verify the social-command role requirement. Please try again shortly.",
          ephemeral: true,
        });
        return;
      }
      if (!canUseSocialCommands) {
        await interaction.reply({
          content: "❌ You need the required social-command role to use this button.",
          ephemeral: true,
        });
        return;
      }

      // Acknowledge within 3 seconds; the GIF fetch can be slow.
      await interaction.deferReply();

      const action = SOCIAL_ACTIONS[actionName];
      const gif = await fetchAnimeGif(action.gifCategory);
      const embed = new EmbedBuilder()
        .setColor(0x2b2d31)
        .setDescription(
          action.render(
            safeDisplayName(clicker.displayName),
            safeDisplayName(original.displayName),
            original.id,
          ),
        );
      if (gif) embed.setImage(gif.url);

      // Remove the button from the original message so it can only be used once.
      await interaction.message.edit({ components: [] }).catch((err) => {
        logger.warn({ err }, "Could not remove social back button");
      });

      await interaction.editReply({
        embeds: [embed],
        allowedMentions: { parse: [] },
      });
    } finally {
      pendingBackMessageIds.delete(interaction.message.id);
    }
  } catch (err) {
    logger.error({ err, customId: interaction.customId }, "Error handling social back button");
    const content = "❌ Something went wrong sending that back.";
    if (interaction.deferred && !interaction.replied) {
      await interaction.deleteReply().catch(() => {});
      await interaction.followUp({ content, ephemeral: true }).catch(() => {});
    } else if (interaction.replied) {
      await interaction.followUp({ content, ephemeral: true }).catch(() => {});
    } else {
      await interaction.reply({ content, ephemeral: true }).catch(() => {});
    }
  }
}

export async function handleShip(message: Message): Promise<void> {
  if (!message.guild) return;

  const users = [...message.mentions.users.values()];
  if (users.length !== 2) {
    await message.reply({
      content: "❌ Mention exactly two different members. Usage: `!ship @user1 @user2`",
      allowedMentions: { parse: [], repliedUser: false },
    });
    return;
  }

  const [firstUser, secondUser] = users;
  if (!firstUser || !secondUser || firstUser.id === secondUser.id) {
    await message.reply({
      content: "❌ Please choose two different members for the ship check.",
      allowedMentions: { parse: [], repliedUser: false },
    });
    return;
  }

  const [firstMember, secondMember] = await Promise.all([
    message.guild.members.cache.get(firstUser.id) ??
      message.guild.members.fetch(firstUser.id).catch(() => null),
    message.guild.members.cache.get(secondUser.id) ??
      message.guild.members.fetch(secondUser.id).catch(() => null),
  ]);
  if (!firstMember || !secondMember) {
    await message.reply({
      content: "❌ I couldn’t find both members in this server.",
      allowedMentions: { parse: [], repliedUser: false },
    });
    return;
  }

  const pairKey = [firstUser.id, secondUser.id].sort().join(":");
  const score = seededScore(`ship:${pairKey}`, 0, 100);
  const filledHearts = Math.round(score / 10);
  const meter = `${"💖".repeat(filledHearts)}${"🤍".repeat(10 - filledHearts)}`;
  const verdict =
    score >= 90
      ? "Cosmic-level duo energy!"
      : score >= 75
        ? "An elite duo with great chemistry."
        : score >= 50
          ? "Good vibes—this could be a fun duo."
          : score >= 25
            ? "A chaotic duo, but an iconic one."
            : "Opposites attract; the memes are guaranteed.";

    const gif = await fetchAnimeGif("handhold");
  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setDescription(
      `**${safeDisplayName(firstMember.displayName)}** × **${safeDisplayName(secondMember.displayName)}**\n` +
      `**${score}%** ${meter}\n${verdict}`,
    );
  if (gif) embed.setImage(gif.url);

  await message.reply({
    embeds: [embed],
    allowedMentions: { parse: [], repliedUser: false },
  });
}
