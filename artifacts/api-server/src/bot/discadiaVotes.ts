import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { and, count, eq, gt, isNotNull, isNull, lte, ne, or, sql, sum } from "drizzle-orm";
import { PermissionFlagsBits, type Client, type GuildMember } from "discord.js";
import {
  botDiscadiaVoteEventsTable,
  botMiningProfilesTable,
  botVoteRewardClaimsTable,
  botVoteRewardSettingsTable,
  db,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { sendVoteRewardNotification } from "./voteRewardEmbeds";
import {
  DISCADIA_REPLAY_SUPPRESSION_WINDOW_MS,
  parseDiscadiaVotePayload,
  verifyDiscadiaWebhookSecret,
} from "./voteWebhookSecurity";

const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;
const EVENT_BATCH_SIZE = 20;
const ROLE_BATCH_SIZE = 50;
const WORKER_INTERVAL_MS = 30_000;
const MAX_CREDIT_BALANCE = 2_147_483_647;

type VoteEvent = typeof botDiscadiaVoteEventsTable.$inferSelect;
type VoteClaim = typeof botVoteRewardClaimsTable.$inferSelect;
type VoteSettings = typeof botVoteRewardSettingsTable.$inferSelect;

let worker: NodeJS.Timeout | undefined;
let workerRunning = false;

function respond(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_WEBHOOK_BODY_BYTES) throw new Error("Webhook body exceeds the size limit");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function isUnknownMember(error: unknown): boolean {
  return !!error && typeof error === "object" && (
    ("code" in error && (error.code === 10007 || error.code === "10007")) ||
    ("status" in error && error.status === 404)
  );
}

function isUnknownRole(error: unknown): boolean {
  return !!error && typeof error === "object" &&
    "code" in error && (error.code === 10011 || error.code === "10011");
}

function retryDelay(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.min(attempts, 6), 60 * 60_000);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 1_000) : "Unknown processing error";
}

export async function handleDiscadiaWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  client: Client | null,
  providedSecret?: string,
): Promise<void> {
  const secret = process.env.DISCADIA_WEBHOOK_SECRET;
  if (!secret) {
    respond(res, 503, { error: "Discadia webhook is not configured" });
    return;
  }
  if (!verifyDiscadiaWebhookSecret(secret, providedSecret)) {
    respond(res, 401, { error: "Invalid webhook token" });
    return;
  }

  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(req);
  } catch (error) {
    logger.warn({ err: error }, "Rejected unreadable or oversized Discadia webhook body");
    respond(res, 413, { error: "Invalid webhook body" });
    return;
  }

  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(rawBody.toString("utf8")) as unknown;
  } catch {
    respond(res, 400, { error: "Invalid JSON payload" });
    return;
  }

  const payload = parseDiscadiaVotePayload(rawPayload);
  if (!payload) {
    respond(res, 400, { error: "Malformed Discadia vote payload" });
    return;
  }

  try {
    const lockKey = `discadia-vote:${payload.guildId}:${payload.userId}`;
    const duplicate = await db.transaction(async (tx: any) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      const [recent] = await tx.select({ voteId: botDiscadiaVoteEventsTable.voteId })
        .from(botDiscadiaVoteEventsTable)
        .where(and(
          eq(botDiscadiaVoteEventsTable.guildId, payload.guildId),
          eq(botDiscadiaVoteEventsTable.userId, payload.userId),
          gt(botDiscadiaVoteEventsTable.receivedAt, new Date(Date.now() - DISCADIA_REPLAY_SUPPRESSION_WINDOW_MS)),
        ))
        .limit(1);
      if (recent) return true;
      await tx.insert(botDiscadiaVoteEventsTable)
        .values({ voteId: randomUUID(), userId: payload.userId, guildId: payload.guildId, weight: 1 });
      return false;
    });
    if (!duplicate && client?.isReady()) void processDiscadiaVoteQueue(client);
    respond(res, 200, { received: true, duplicate, platform: "discadia" });
  } catch (error) {
    logger.error({ err: error, guildId: payload.guildId }, "Could not persist Discadia vote event");
    respond(res, 503, { error: "Vote event could not be stored; retry later" });
  }
}

export function startDiscadiaVoteWorker(client: Client): void {
  if (worker) return;
  worker = setInterval(() => void processDiscadiaVoteQueue(client), WORKER_INTERVAL_MS);
  worker.unref();
  void processDiscadiaVoteQueue(client);
}

async function processDiscadiaVoteQueue(client: Client): Promise<void> {
  if (workerRunning) return;
  workerRunning = true;
  try {
    const staleBefore = new Date(Date.now() - 5 * 60_000);
    await db.update(botDiscadiaVoteEventsTable)
      .set({ status: "pending", processingAt: null, nextAttemptAt: Date.now() })
      .where(and(
        eq(botDiscadiaVoteEventsTable.status, "processing"),
        lte(botDiscadiaVoteEventsTable.processingAt, staleBefore),
      ));

    const pending = await db.select({ voteId: botDiscadiaVoteEventsTable.voteId })
      .from(botDiscadiaVoteEventsTable)
      .where(and(
        eq(botDiscadiaVoteEventsTable.status, "pending"),
        lte(botDiscadiaVoteEventsTable.nextAttemptAt, Date.now()),
      ))
      .limit(EVENT_BATCH_SIZE);

    for (const { voteId } of pending) {
      const [event] = await db.update(botDiscadiaVoteEventsTable)
        .set({ status: "processing", processingAt: new Date(), attempts: sql`${botDiscadiaVoteEventsTable.attempts} + 1` })
        .where(and(
          eq(botDiscadiaVoteEventsTable.voteId, voteId),
          eq(botDiscadiaVoteEventsTable.status, "pending"),
          lte(botDiscadiaVoteEventsTable.nextAttemptAt, Date.now()),
        ))
        .returning();
      if (!event) continue;

      try {
        await processVoteEvent(client, event);
        await db.update(botDiscadiaVoteEventsTable)
          .set({ status: "completed", processingAt: null, lastError: null })
          .where(eq(botDiscadiaVoteEventsTable.voteId, voteId));
      } catch (error) {
        await db.update(botDiscadiaVoteEventsTable)
          .set({
            status: "pending",
            processingAt: null,
            nextAttemptAt: Date.now() + retryDelay(event.attempts),
            lastError: errorMessage(error),
          })
          .where(eq(botDiscadiaVoteEventsTable.voteId, voteId));
        logger.error({ err: error, voteId, attempts: event.attempts }, "Discadia vote processing will retry");
      }
    }

    await processVoteRoleClaims(client);
    await processVoteNotifications(client);
  } catch (error) {
    logger.error({ err: error }, "Discadia vote worker failed");
  } finally {
    workerRunning = false;
  }
}

async function processVoteEvent(client: Client, event: VoteEvent): Promise<void> {
  if (!event.guildId) {
    logger.warn({ voteId: event.voteId }, "Discarding Discadia vote event without a guild ID");
    return;
  }
  const settings = await db.select().from(botVoteRewardSettingsTable)
    .where(and(
      eq(botVoteRewardSettingsTable.guildId, event.guildId),
      eq(botVoteRewardSettingsTable.discadiaEnabled, true),
    ));

  for (const setting of settings) {
    const claim = await findOrCreateVoteClaim(event, setting, client);
    if (!claim || claim.claimStatus !== "rewarded") continue;
    await processRoleClaim(client, claim);
    const [updatedClaim] = await db.select().from(botVoteRewardClaimsTable)
      .where(and(
        eq(botVoteRewardClaimsTable.voteId, claim.voteId),
        eq(botVoteRewardClaimsTable.platform, "discadia"),
        eq(botVoteRewardClaimsTable.guildId, claim.guildId),
      ))
      .limit(1);
    await notifyVoter(client, updatedClaim ?? claim);
  }
}

async function findOrCreateVoteClaim(
  event: VoteEvent,
  settings: VoteSettings,
  client: Client,
): Promise<VoteClaim | null> {
  if (!event.guildId || event.guildId !== settings.guildId) return null;
  const [existing] = await db.select().from(botVoteRewardClaimsTable)
    .where(and(
      eq(botVoteRewardClaimsTable.voteId, event.voteId),
      eq(botVoteRewardClaimsTable.platform, "discadia"),
      eq(botVoteRewardClaimsTable.guildId, settings.guildId),
    ))
    .limit(1);
  if (existing) return existing;

  const guild = client.guilds.cache.get(event.guildId);
  if (!guild) return null;

  let member: GuildMember;
  try {
    member = await guild.members.fetch(event.userId);
  } catch (error) {
    if (!isUnknownMember(error)) throw error;
    const [claim] = await db.insert(botVoteRewardClaimsTable)
      .values({
        voteId: event.voteId,
        platform: "discadia",
        guildId: guild.id,
        userId: event.userId,
        claimStatus: "not_member",
        creditsAwarded: 0,
        roleStatus: "none",
        notificationStatus: "not_applicable",
      })
      .onConflictDoNothing()
      .returning();
    if (claim) return claim;
    const [racedClaim] = await db.select().from(botVoteRewardClaimsTable)
      .where(and(
        eq(botVoteRewardClaimsTable.voteId, event.voteId),
        eq(botVoteRewardClaimsTable.platform, "discadia"),
        eq(botVoteRewardClaimsTable.guildId, guild.id),
      ))
      .limit(1);
    return racedClaim ?? null;
  }

  const requestedCredits = settings.discadiaCreditsPerVote * event.weight;
  if (!Number.isSafeInteger(requestedCredits) || requestedCredits < 0) {
    throw new Error(`Invalid Discadia vote credit reward configured for guild ${guild.id}`);
  }

  return db.transaction(async (tx: any) => {
    await tx.insert(botMiningProfilesTable)
      .values({ guildId: guild.id, userId: member.id })
      .onConflictDoNothing();
    const [profile] = await tx.select({ coins: botMiningProfilesTable.coins })
      .from(botMiningProfilesTable)
      .where(and(
        eq(botMiningProfilesTable.guildId, guild.id),
        eq(botMiningProfilesTable.userId, member.id),
      ))
      .for("update");
    if (!profile) throw new Error("Could not load Discadia vote-reward credit profile");

    const creditsAwarded = Math.min(requestedCredits, Math.max(0, MAX_CREDIT_BALANCE - profile.coins));
    const [claim] = await tx.insert(botVoteRewardClaimsTable)
      .values({
        voteId: event.voteId,
        platform: "discadia",
        guildId: guild.id,
        userId: member.id,
        claimStatus: "rewarded",
        creditsAwarded,
        roleId: settings.discadiaRoleId,
        roleDurationMs: settings.discadiaRoleDurationMs,
        roleStatus: settings.discadiaRoleId ? "pending_add" : "none",
        notificationStatus: "pending",
      })
      .onConflictDoNothing()
      .returning();

    if (!claim) {
      const [racedClaim] = await tx.select().from(botVoteRewardClaimsTable)
        .where(and(
          eq(botVoteRewardClaimsTable.voteId, event.voteId),
          eq(botVoteRewardClaimsTable.platform, "discadia"),
          eq(botVoteRewardClaimsTable.guildId, guild.id),
        ))
        .limit(1);
      return racedClaim ?? null;
    }

    if (creditsAwarded > 0) {
      await tx.update(botMiningProfilesTable)
        .set({ coins: profile.coins + creditsAwarded, updatedAt: new Date() })
        .where(and(
          eq(botMiningProfilesTable.guildId, guild.id),
          eq(botMiningProfilesTable.userId, member.id),
        ));
    }
    return claim;
  });
}

async function updateClaim(
  claim: VoteClaim,
  values: Partial<typeof botVoteRewardClaimsTable.$inferInsert>,
): Promise<void> {
  await db.update(botVoteRewardClaimsTable)
    .set(values)
    .where(and(
      eq(botVoteRewardClaimsTable.voteId, claim.voteId),
      eq(botVoteRewardClaimsTable.platform, "discadia"),
      eq(botVoteRewardClaimsTable.guildId, claim.guildId),
    ));
}

async function retryRole(claim: VoteClaim, error: unknown): Promise<void> {
  const attempts = claim.roleAttempts + 1;
  await updateClaim(claim, {
    roleAttempts: attempts,
    roleNextAttemptAt: Date.now() + retryDelay(attempts),
  });
  logger.warn({ err: error, guildId: claim.guildId, userId: claim.userId, roleId: claim.roleId, attempts }, "Discadia vote role assignment will retry");
}

async function getOtherActiveRoleGrants(claim: VoteClaim): Promise<VoteClaim[]> {
  if (!claim.roleId) return [];
  return db.select().from(botVoteRewardClaimsTable)
    .where(and(
      eq(botVoteRewardClaimsTable.guildId, claim.guildId),
      eq(botVoteRewardClaimsTable.userId, claim.userId),
      eq(botVoteRewardClaimsTable.roleId, claim.roleId),
      eq(botVoteRewardClaimsTable.roleStatus, "assigned"),
      or(
        ne(botVoteRewardClaimsTable.voteId, claim.voteId),
        ne(botVoteRewardClaimsTable.platform, claim.platform),
      ),
      or(
        isNull(botVoteRewardClaimsTable.roleExpiresAt),
        gt(botVoteRewardClaimsTable.roleExpiresAt, Date.now()),
      ),
    ));
}

async function processRoleClaim(client: Client, claim: VoteClaim): Promise<void> {
  const guild = client.guilds.cache.get(claim.guildId);
  if (!guild || !claim.roleId) return;

  if (claim.roleStatus === "pending_add") {
    try {
      const member = await guild.members.fetch(claim.userId);
      const role = await guild.roles.fetch(claim.roleId).catch((error: unknown) => {
        if (isUnknownRole(error)) return null;
        throw error;
      });
      if (!role || role.managed || role.id === guild.id) {
        await updateClaim(claim, { roleStatus: "failed" });
        logger.error({ guildId: guild.id, userId: claim.userId, roleId: claim.roleId }, "Configured Discadia vote role is missing or managed");
        return;
      }
      if (member.roles.cache.has(role.id)) {
        const activeGrants = await getOtherActiveRoleGrants(claim);
        if (activeGrants.length === 0) {
          await updateClaim(claim, claim.roleAttempts > 0
            ? { roleStatus: "assigned", roleExpiresAt: claim.roleDurationMs ? Date.now() + claim.roleDurationMs : null, roleNextAttemptAt: 0 }
            : { roleStatus: "already_had" });
          return;
        }
        if (activeGrants.some((grant) => grant.roleExpiresAt === null)) {
          await updateClaim(claim, { roleStatus: "already_had" });
          return;
        }
        const latestExpiry = Math.max(Date.now(), ...activeGrants.map((grant) => grant.roleExpiresAt ?? 0));
        await updateClaim(claim, {
          roleStatus: "assigned",
          roleExpiresAt: claim.roleDurationMs === null ? null : latestExpiry + claim.roleDurationMs,
          roleNextAttemptAt: 0,
        });
        return;
      }

      const botMember = guild.members.me ?? await guild.members.fetchMe();
      if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles) || botMember.roles.highest.comparePositionTo(role) <= 0) {
        await retryRole(claim, new Error("Bot needs Manage Roles and its highest role must be above the reward role"));
        return;
      }

      await member.roles.add(role, "Discadia vote reward");
      await updateClaim(claim, {
        roleStatus: "assigned",
        roleExpiresAt: claim.roleDurationMs ? Date.now() + claim.roleDurationMs : null,
        roleNextAttemptAt: 0,
      });
    } catch (error) {
      if (isUnknownMember(error)) {
        await updateClaim(claim, { roleStatus: "failed" });
        logger.warn({ guildId: claim.guildId, userId: claim.userId }, "Voter left the server before their Discadia vote role could be assigned");
        return;
      }
      await retryRole(claim, error);
    }
    return;
  }

  if (claim.roleStatus === "assigned" && claim.roleExpiresAt !== null && claim.roleExpiresAt <= Date.now()) {
    try {
      const activeGrants = await getOtherActiveRoleGrants(claim);
      if (activeGrants.length > 0) {
        await updateClaim(claim, { roleStatus: "removed", roleExpiresAt: null, roleNextAttemptAt: 0 });
        return;
      }
      const member = await guild.members.fetch(claim.userId);
      if (member.roles.cache.has(claim.roleId)) {
        const role = await guild.roles.fetch(claim.roleId).catch((error: unknown) => {
          if (isUnknownRole(error)) return null;
          throw error;
        });
        if (role) await member.roles.remove(role, "Discadia temporary vote reward expired");
      }
      await updateClaim(claim, { roleStatus: "removed", roleExpiresAt: null, roleNextAttemptAt: 0 });
    } catch (error) {
      if (isUnknownMember(error)) {
        await updateClaim(claim, { roleStatus: "removed", roleExpiresAt: null, roleNextAttemptAt: 0 });
        return;
      }
      const attempts = claim.roleAttempts + 1;
      await updateClaim(claim, { roleAttempts: attempts, roleNextAttemptAt: Date.now() + retryDelay(attempts) });
      logger.warn({ err: error, guildId: claim.guildId, userId: claim.userId, roleId: claim.roleId }, "Temporary Discadia vote role removal will retry");
    }
  }
}

async function notifyVoter(client: Client, claim: VoteClaim): Promise<void> {
  if (claim.notificationStatus !== "pending") return;
  const [reserved] = await db.update(botVoteRewardClaimsTable)
    .set({ notificationStatus: "sending", notificationUpdatedAt: new Date() })
    .where(and(
      eq(botVoteRewardClaimsTable.voteId, claim.voteId),
      eq(botVoteRewardClaimsTable.platform, "discadia"),
      eq(botVoteRewardClaimsTable.guildId, claim.guildId),
      eq(botVoteRewardClaimsTable.notificationStatus, "pending"),
    ))
    .returning({ voteId: botVoteRewardClaimsTable.voteId });
  if (!reserved) return;

  try {
    await sendVoteRewardNotification(client, claim, "discadia");
    await updateClaim(claim, { notificationStatus: "sent", notificationUpdatedAt: new Date() });
  } catch (error) {
    await updateClaim(claim, { notificationStatus: "unavailable", notificationUpdatedAt: new Date() });
    logger.info({ err: error, guildId: claim.guildId, userId: claim.userId, voteId: claim.voteId }, "Could not DM Discadia vote reward; rewards remain processed");
  }
}

async function processVoteRoleClaims(client: Client): Promise<void> {
  const now = Date.now();
  const claims = await db.select().from(botVoteRewardClaimsTable)
    .where(and(
      eq(botVoteRewardClaimsTable.platform, "discadia"),
      or(
        and(
          eq(botVoteRewardClaimsTable.roleStatus, "pending_add"),
          lte(botVoteRewardClaimsTable.roleNextAttemptAt, now),
        ),
        and(
          eq(botVoteRewardClaimsTable.roleStatus, "assigned"),
          isNotNull(botVoteRewardClaimsTable.roleExpiresAt),
          lte(botVoteRewardClaimsTable.roleExpiresAt, now),
          lte(botVoteRewardClaimsTable.roleNextAttemptAt, now),
        ),
      ),
    ))
    .limit(ROLE_BATCH_SIZE);
  for (const claim of claims) await processRoleClaim(client, claim);
}

async function processVoteNotifications(client: Client): Promise<void> {
  const staleSendingBefore = new Date(Date.now() - 5 * 60_000);
  await db.update(botVoteRewardClaimsTable)
    .set({ notificationStatus: "pending", notificationUpdatedAt: new Date() })
    .where(and(
      eq(botVoteRewardClaimsTable.platform, "discadia"),
      eq(botVoteRewardClaimsTable.notificationStatus, "sending"),
      lte(botVoteRewardClaimsTable.notificationUpdatedAt, staleSendingBefore),
    ));
  const claims = await db.select().from(botVoteRewardClaimsTable)
    .where(and(
      eq(botVoteRewardClaimsTable.platform, "discadia"),
      eq(botVoteRewardClaimsTable.notificationStatus, "pending"),
    ))
    .limit(ROLE_BATCH_SIZE);
  for (const claim of claims) await notifyVoter(client, claim);
}

export async function getVoteRewardStats(guildId: string, platform: "topgg" | "discadia" = "topgg"): Promise<{ votes: number; credits: number }> {
  const [stats] = await db.select({
    votes: count(),
    credits: sum(botVoteRewardClaimsTable.creditsAwarded),
  })
    .from(botVoteRewardClaimsTable)
    .where(and(
      eq(botVoteRewardClaimsTable.guildId, guildId),
      eq(botVoteRewardClaimsTable.platform, platform),
      eq(botVoteRewardClaimsTable.claimStatus, "rewarded"),
    ));
  return { votes: Number(stats?.votes ?? 0), credits: Number(stats?.credits ?? 0) };
}
