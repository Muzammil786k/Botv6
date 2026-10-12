import { createCanvas, loadImage, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import { logger } from "../lib/logger";

const WIDTH = 1400;
const HEIGHT = 720;
const AVATAR_SIZE = 250;
const AVATAR_X = 120;
const AVATAR_Y = 195;
const QUOTE_X = 490;
const QUOTE_WIDTH = 790;
const QUOTE_TOP = 130;
const QUOTE_HEIGHT = 365;
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
      if (line && context.measureText(candidate).width > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
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
    context.fillStyle = "#202020";
    context.fillRect(AVATAR_X, AVATAR_Y, AVATAR_SIZE, AVATAR_SIZE);
    context.fillStyle = "#ffffff";
    context.font = "bold 112px Arial, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(fallback.slice(0, 1).toUpperCase(), centerX, centerY);
  }
  context.restore();

  context.beginPath();
  context.arc(centerX, centerY, AVATAR_SIZE / 2, 0, Math.PI * 2);
  context.strokeStyle = "#ffffff";
  context.lineWidth = 4;
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
  let fontSize = 42;
  let lineHeight = 54;
  let lines: string[] = [];
  while (fontSize >= 26) {
    context.font = `bold ${fontSize}px Arial, sans-serif`;
    lineHeight = Math.round(fontSize * 1.35);
    lines = wrapText(context, cleanQuote, QUOTE_WIDTH);
    if (lines.length * lineHeight <= QUOTE_HEIGHT) break;
    fontSize -= 2;
  }

  context.fillStyle = "#ffffff";
  context.textAlign = "left";
  context.textBaseline = "middle";
  const textHeight = lines.length * lineHeight;
  let y = QUOTE_TOP + (QUOTE_HEIGHT - textHeight) / 2 + lineHeight / 2;
  for (const line of lines) {
    context.fillText(line, QUOTE_X, y);
    y += lineHeight;
  }

  context.textBaseline = "alphabetic";
  context.font = "bold 32px Arial, sans-serif";
  context.fillStyle = "#ffffff";
  context.fillText(displayName.slice(0, 48), AVATAR_X, 565);
  context.font = "24px Arial, sans-serif";
  context.fillStyle = "#ffffff";
  context.fillText(`@${username}`.slice(0, 64), AVATAR_X, 605);

  return canvas.encode("png");
}