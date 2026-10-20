import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_TOPGG_SIGNATURE_AGE_SECONDS = 5 * 60;
export const DISCADIA_REPLAY_SUPPRESSION_WINDOW_MS = 10 * 60_000;

export interface DiscadiaVotePayload {
  userId: string;
  guildId: string;
  serverTitle: string;
  serverSlug: string;
  voteUrl: string;
}

export function verifyTopggSignature(
  header: string | undefined,
  rawBody: Buffer,
  secret: string,
  nowMs = Date.now(),
): boolean {
  const match = /^t=(\d+),v1=([a-f0-9]{64})$/i.exec(header?.trim() ?? "");
  if (!match) return false;
  const timestamp = Number(match[1]);
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowMs / 1000 - timestamp) > MAX_TOPGG_SIGNATURE_AGE_SECONDS) return false;
  const expected = createHmac("sha256", secret).update(`${match[1]}.${rawBody.toString("utf8")}`).digest();
  const received = Buffer.from(match[2]!, "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function verifyDiscadiaWebhookSecret(expectedSecret: string, providedSecret: string | undefined): boolean {
  if (!providedSecret || Buffer.byteLength(expectedSecret) < 32) return false;
  const expected = Buffer.from(expectedSecret);
  const provided = Buffer.from(providedSecret);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function parseDiscadiaVotePayload(value: unknown): DiscadiaVotePayload | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Record<string, unknown>;
  const { user_id: userId, guild_id: guildId, server_title: serverTitle, server_slug: serverSlug, vote_url: voteUrl } = payload;
  if (
    typeof userId !== "string" || !/^\d{17,20}$/.test(userId) ||
    typeof guildId !== "string" || !/^\d{17,20}$/.test(guildId) ||
    typeof serverTitle !== "string" || serverTitle.trim().length === 0 || serverTitle.length > 256 ||
    typeof serverSlug !== "string" || serverSlug.length === 0 || serverSlug.length > 128 || /[/?#\\]/.test(serverSlug) ||
    typeof voteUrl !== "string" || !isDiscadiaVoteUrl(voteUrl, serverSlug)
  ) return null;
  return { userId, guildId, serverTitle, serverSlug, voteUrl };
}

function isDiscadiaVoteUrl(value: string, serverSlug: string): boolean {
  try {
    const url = new URL(value);
    const decodedPath = decodeURIComponent(url.pathname).replace(/\/$/, "");
    return url.protocol === "https:" &&
      (url.hostname === "discadia.com" || url.hostname === "www.discadia.com") &&
      decodedPath === `/vote/${serverSlug}`;
  } catch {
    return false;
  }
}