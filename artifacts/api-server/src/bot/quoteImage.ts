import { createRequire } from "node:module";
import { createCanvas, GlobalFonts, loadImage, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import { logger } from "../lib/logger";

const require = createRequire(import.meta.url);
const FONT_FAMILY = '"Quote Sans", sans-serif';
GlobalFonts.registerFromPath(require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans.ttf"), "Quote Sans");
GlobalFonts.registerFromPath(require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf"), "Quote Sans");

const WIDTH = 1600;
const HEIGHT = 630;
const AVATAR_SIZE = 290;
const AVATAR_X = 100;
const AVATAR_Y = 170;
const QUOTE_X = 530;
const QUOTE_WIDTH = 1010;
const QUOTE_TOP = 75;
const QUOTE_HEIGHT = 355;
const MIN_QUOTE_FONT_SIZE = 26;
const MAX_QUOTE_FONT_SIZE = 60;
const MAX_QUOTE_LENGTH = 450;

async function loadAvatar(url: string): Promise<Image | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`Avatar request failed with status ${response.status}`);
    return await loadImage(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    logger.warn({ err }, "Could not load avatar for quote image");
    return null;
  }
}

function wrapText(context: SKRSContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }

    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (context.measureText(candidate).width <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) {
        lines.push(line);
        line = "";
      }

      for (const character of Array.from(word)) {
        const characterCandidate = line + character;
        if (line && context.measureText(characterCandidate).width > maxWidth) {
          lines.push(line);
          line = character;
        } else {
          line = characterCandidate;
        }
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

function drawAvatar(context: SKRSContext2D, avatar: Image | null, fallback: string): void {
  const centerX = AVATAR_X + AVATAR_SIZE / 2;
  const centerY = AVATAR_Y + AVATAR_SIZE / 2;

  context.save();
  context.beginPath();
  context.arc(centerX, centerY, AVATAR_SIZE / 2, 0, Math.PI * 2);
  context.clip();
  if (avatar) {
    context.drawImage(avatar, AVATAR_X, AVATAR_Y, AVATAR_SIZE, AVATAR_SIZE);
  } else {
    context.fillStyle = "#111111";
    context.fillRect(AVATAR_X, AVATAR_Y, AVATAR_SIZE, AVATAR_SIZE);
    context.fillStyle = "#ffffff";
    context.font = `bold 112px ${FONT_FAMILY}`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(fallback.slice(0, 1).toUpperCase(), centerX, centerY);
  }
  context.restore();

  context.beginPath();
  context.arc(centerX, centerY, AVATAR_SIZE / 2, 0, Math.PI * 2);
  context.strokeStyle = "#2a2a2a";
  context.lineWidth = 2;
  context.stroke();
}

export async function renderQuoteImage(
  avatarUrl: string,
  displayName: string,
  username: string,
  quote: string,
): Promise<Buffer> {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const context = canvas.getContext("2d");
  context.fillStyle = "#000000";
  context.fillRect(0, 0, WIDTH, HEIGHT);

  drawAvatar(context, await loadAvatar(avatarUrl), username);

  const cleanQuote = Array.from(quote.trim()).slice(0, MAX_QUOTE_LENGTH).join("");
  let fontSize = MAX_QUOTE_FONT_SIZE;
  let lineHeight = Math.round(fontSize * 1.25);
  let lines: string[] = [];
  while (fontSize >= MIN_QUOTE_FONT_SIZE) {
    context.font = `bold ${fontSize}px ${FONT_FAMILY}`;
    lineHeight = Math.round(fontSize * 1.25);
    lines = wrapText(context, cleanQuote, QUOTE_WIDTH);
    if (lines.length * lineHeight <= QUOTE_HEIGHT) break;
    if (fontSize === MIN_QUOTE_FONT_SIZE) break;
    fontSize -= 2;
  }

  context.fillStyle = "#ffffff";
  context.textAlign = "left";
  context.textBaseline = "middle";
  const textHeight = lines.length * lineHeight;
  const textTop = QUOTE_TOP + (QUOTE_HEIGHT - textHeight) / 2;
  let y = textTop + lineHeight / 2;
  for (const line of lines) {
    context.fillText(line, QUOTE_X, y);
    y += lineHeight;
  }

  const authorY = Math.min(QUOTE_TOP + QUOTE_HEIGHT + 38, textTop + textHeight + 46);
  context.textBaseline = "alphabetic";
  context.font = `26px ${FONT_FAMILY}`;
  context.fillStyle = "#bdbdbd";
  context.fillText(`- ${displayName}`.slice(0, 64), QUOTE_X, authorY, QUOTE_WIDTH);
  context.font = `18px ${FONT_FAMILY}`;
  context.fillStyle = "#777777";
  context.fillText(`@${username}`.slice(0, 72), QUOTE_X, authorY + 36, QUOTE_WIDTH);

  context.textAlign = "right";
  context.font = `16px ${FONT_FAMILY}`;
  context.fillStyle = "#666666";
  context.fillText("Hangouts | discord.gg/hangouts", WIDTH - 90, HEIGHT - 28, WIDTH - 180);

  return canvas.encode("png");
}
