import { createRequire } from "node:module";
import { createCanvas, GlobalFonts, loadImage, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import { logger } from "../lib/logger";

const require = createRequire(import.meta.url);
const FONT_FAMILY = '"Quote Sans", sans-serif';
GlobalFonts.registerFromPath(require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans.ttf"), "Quote Sans");
GlobalFonts.registerFromPath(require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf"), "Quote Sans");

const WIDTH = 1600;
const HEIGHT = 900;
const AVATAR_WIDTH = 1020;
const QUOTE_X = 810;
const QUOTE_WIDTH = 700;
const QUOTE_TOP = 300;
const QUOTE_HEIGHT = 365;
const MIN_QUOTE_FONT_SIZE = 20;
const MAX_QUOTE_FONT_SIZE = 56;
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
  if (avatar) {
    const scale = Math.max(AVATAR_WIDTH / avatar.width, HEIGHT / avatar.height);
    const sourceWidth = AVATAR_WIDTH / scale;
    const sourceHeight = HEIGHT / scale;
    const sourceX = (avatar.width - sourceWidth) / 2;
    const sourceY = (avatar.height - sourceHeight) / 2;
    context.save();
    context.filter = "grayscale(100%) brightness(0.68) contrast(1.12)";
    context.drawImage(
      avatar,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      0,
      0,
      AVATAR_WIDTH,
      HEIGHT,
    );
    context.restore();
  } else {
    context.fillStyle = "#111111";
    context.fillRect(0, 0, AVATAR_WIDTH, HEIGHT);
    context.fillStyle = "#777777";
    context.font = `bold 260px ${FONT_FAMILY}`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(fallback.slice(0, 1).toUpperCase(), AVATAR_WIDTH / 2, HEIGHT / 2);
  }

  const gradient = context.createLinearGradient(AVATAR_WIDTH * 0.48, 0, AVATAR_WIDTH + 180, 0);
  gradient.addColorStop(0, "rgba(0, 0, 0, 0)");
  gradient.addColorStop(0.4, "rgba(0, 0, 0, 0.28)");
  gradient.addColorStop(0.82, "rgba(0, 0, 0, 0.94)");
  gradient.addColorStop(1, "#000000");
  context.fillStyle = gradient;
  context.fillRect(0, 0, WIDTH, HEIGHT);
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
  context.textAlign = "left";
  context.textBaseline = "alphabetic";
  context.fillStyle = "#555555";
  context.font = `bold 150px ${FONT_FAMILY}`;
  context.fillText("“", QUOTE_X - 5, 250);

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
  const maxLines = Math.floor(QUOTE_HEIGHT / lineHeight);
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    let lastLine = lines[maxLines - 1]!;
    while (context.measureText(`${lastLine}…`).width > QUOTE_WIDTH) {
      lastLine = Array.from(lastLine).slice(0, -1).join("");
    }
    lines[maxLines - 1] = `${lastLine}…`;
  }

  context.fillStyle = "#ffffff";
  context.textBaseline = "middle";
  const textHeight = lines.length * lineHeight;
  const textTop = QUOTE_TOP + (QUOTE_HEIGHT - textHeight) / 2;
  let y = textTop + lineHeight / 2;
  for (const line of lines) {
    context.fillText(line, QUOTE_X, y, QUOTE_WIDTH);
    y += lineHeight;
  }

  const authorY = Math.max(720, textTop + textHeight + 44);
  context.textBaseline = "alphabetic";
  context.font = `bold 30px ${FONT_FAMILY}`;
  context.fillStyle = "#777777";
  context.fillText("-", QUOTE_X, authorY);
  context.fillStyle = "#ffffff";
  context.fillText(displayName.slice(0, 64), QUOTE_X + 22, authorY, QUOTE_WIDTH - 22);
  context.font = `21px ${FONT_FAMILY}`;
  context.fillStyle = "#777777";
  context.fillText(`@${username}`.slice(0, 72), QUOTE_X, authorY + 36, QUOTE_WIDTH);

  context.textAlign = "right";
  context.font = `17px ${FONT_FAMILY}`;
  context.fillStyle = "#666666";
  context.fillText("Hangouts | discord.gg/hangouts", WIDTH - 72, HEIGHT - 34, 600);

  return canvas.encode("png");
}
