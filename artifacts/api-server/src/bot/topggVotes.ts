import type { IncomingMessage, ServerResponse } from "node:http";
import { and, count, eq, gt, isNotNull, isNull, lte, ne, or, sql, sum } from "drizzle-orm";
import { PermissionFlagsBits, type Client, type GuildMember } from "discord.js";
import {
  botMiningProfilesTable,
  botTopggVoteEventsTable,
  botVoteRewardClaimsTable,
  botVoteRewardSettingsTable,
  db,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { sendVoteRewardNotification } from "./voteRewardEmbeds";
import { verifyTopggSignature } from "./voteWebhookSecurity";

const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;
const EVENT_BATCH_SIZE = 20;
const ROLE_BATCH_SIZE = 50;
const WORKER_INTERVAL_MS = 30_000;
const MAX_CREDIT_BALANCE = 2_147_483_647;

interface TopggPayload {
  type?: unknown;
  data?: {
    id?: unknown;
    weight?: unknown;
    project?: { type?: unknown; platform?: unknown; platform_id?: unknown };
    user?: { platform_id?: unknown };
  };
}

type VoteEvent = typeof botTopggVoteEventsTable.$inferSelect;
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

function isDiscordId(value: unknown): value is string {
  return typeof value === "string" && /^\d{17,20}$/.test(value);
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

export async function handleTopggWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  client: Client | null,
): Promise<void> {
  const secret = process.env.TOPGG_WEBHOOK_SECRET;
  const projectId = process.env.TOPGG_PROJECT_ID;
  if (!secret || !projectId) {
    respond(res, 503, { error: "Top.gg webhook is not configured" });
    return;
  }

  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(req);
  } catch (error) {
    logger.warn({ err: error }, "Rejected unreadable or oversized Top.gg webhook body");
    respond(res, 413, { error: "Invalid webhook body" });
    return;
  }

  const signatureHeader = req.headers["x-topgg-signature"];
  const signature = typeof signatureHeader === "string" ? signatureHeader : undefined;
  if (!verifyTopggSignature(signature, rawBody, secret)) {
    logger.warn("Rejected Top.gg webhook with an invalid signature");
    respond(res, 401, { error: "Invalid signature" });
    return;
  }

  let payload: TopggPayload;
  try {
    payload = JSON.parse(rawBody.toString("utf8")) as TopggPayload;
  } catch {
    respond(res, 400, { error: "Invalid JSON payload" });
    return;
  }

  const data = payload.data;
  if (data?.project?.platform_id !== projectId || data.project.platform !== "discord" || data.project.type !== "bot") {
    logger.warn({ projectId: data?.project?.platform_id }, "Rejected Top.gg webhook for another project");
    respond(res, 403, { error: "Unexpected Top.gg project" });
    return;
  }

  if (payload.type === "webhook.test") {
    logger.info("Received Top.gg dashboard webhook test; no rewards were issued");
    respond(res, 200, { received: true, test: true, rewardsIssued: false });
    return;
  }
  if (payload.type !== "vote.create") {
    respond(res, 200, { received: true, ignored: true });
    return;
  }

  const voteId = data.id;
  const userId = data.user?.platform_id;
  const weight = data.weight;
  if (
    typeof voteId !== "string" || !/^\d{1,24}$/.test(voteId) ||
    !isDiscordId(userId) || !Number.isInteger(weight) || Number(weight) < 1 || Number(weight) > 2
  ) {
    respond(res, 400, { error: "Malformed vote.create event" });
    return;
  }

  try {
    const [inserted] = await db.insert(botTopggVoteEventsTable)
      .values({ voteId, userId, weight: Number(weight) })
      .onConflictDoNothing()
      .returning({ voteId: botTopggVoteEventsTable.voteId });
    if (inserted && client?.isReady()) void processTopggVoteQueue(client);
    respond(res, 200, { received: true, duplicate: !inserted });
  } catch (error) {
    logger.error({ err: error, voteId }, "Could not persist Top.gg vote event");
    respond(res, 503, { error: "Vote event could not be stored; retry later" });
  }
}

export function startTopggVoteWorker(client: Client): void {
  if (worker) return;
  worker = setInterval(() => void processTopggVoteQueue(client), WORKER_INTERVAL_MS);
  worker.unref();
  void processTopggVoteQueue(client);
}

async function processTopggVoteQueue(client: Client): Promise<void> {
  if (workerRunning) return;
  workerRunning = true;
  try {
    const staleBefore = new Date(Date.now() - 5 * 60_000);
    await db.update(botTopggVoteEventsTable)
      .set({ status: "pending", processingAt: null, nextAttemptAt: Date.now() })
      .where(and(
        eq(botTopggVoteEventsTable.status, "processing"),
        lte(botTopggVoteEventsTable.processingAt, staleBefore),
      ));

    const pending = await db.select({ voteId: botTopggVoteEventsTable.voteId })
      .from(botTopggVoteEventsTable)
      .where(and(
        eq(botTopggVoteEventsTable.status, "pending"),
        lte(botTopggVoteEventsTable.nextAttemptAt, Date.now()),
      ))
      .limit(EVENT_BATCH_SIZE);

    for (const { voteId } of pending) {
      const [event] = await db.update(botTopggVoteEventsTable)
        .set({ status: "processing", processingAt: new Date(), attempts: sql`${botTopggVoteEventsTable.attempts} + 1` })
        .where(and(
          eq(botTopggVoteEventsTable.voteId, voteId),
          eq(botTopggVoteEventsTable.status, "pending"),
          lte(botTopggVoteEventsTable.nextAttemptAt, Date.now()),
        ))
        .returning();
      if (!event) continue;

      try {
        await processVoteEvent(client, event);
        await db.update(botTopggVoteEventsTable)
          .set({ status: "completed", processingAt: null, lastError: null })
          .where(eq(botTopggVoteEventsTable.voteId, voteId));
      } catch (error) {
        await db.update(botTopggVoteEventsTable)
          .set({
            status: "pending",
            processingAt: null,
            nextAttemptAt: Date.now() + retryDelay(event.attempts),
            lastError: errorMessage(error),
          })
          .where(eq(botTopggVoteEventsTable.voteId, voteId));
        logger.error({ err: error, voteId, attempts: event.attempts }, "Top.gg vote processing will retry");
      }
    }

    await processVoteRoleClaims(client);
    await processVoteNotifications(client);
  } catch (error) {
    logger.error({ err: error }, "Top.gg vote worker failed");
  } finally {
    workerRunning = false;
  }
}

async function processVoteEvent(client: Client, event: VoteEvent): Promise<void> {
  const settings = await db.select().from(botVoteRewardSettingsTable)
    .where(or(eq(botVoteRewardSettingsTable.enabled, true), eq(botVoteRewardSettingsTable.topggEnabled, true)));

  for (const setting of settings) {
    const claim = await findOrCreateVoteClaim(event, setting, client);
    if (!claim || claim.claimStatus !== "rewarded") continue;
    await processRoleClaim(client, claim);
    const [updatedClaim] = await db.select().from(botVoteRewardClaimsTable)
      .where(and(
        eq(botVoteRewardClaimsTable.voteId, claim.voteId),
        eq(botVoteRewardClaimsTable.platform, "topgg"),
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
  const [existing] = await db.select().from(botVoteRewardClaimsTable)
    .where(and(
      eq(botVoteRewardClaimsTable.voteId, event.voteId),
      eq(botVoteRewardClaimsTable.platform, "topgg"),
      eq(botVoteRewardClaimsTable.guildId, settings.guildId),
    ))
    .limit(1);
  if (existing) return existing;

  const guild = client.guilds.cache.get(settings.guildId);
  if (!guild) return null;

  let member: GuildMember;
  try {
    member = await guild.members.fetch(event.userId);
  } catch (error) {
    if (!isUnknownMember(error)) throw error;
    const [claim] = await db.insert(botVoteRewardClaimsTable)
      .values({
        voteId: event.voteId,
        platform: "topgg",
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
        eq(botVoteRewardClaimsTable.platform, "topgg"),
        eq(botVoteRewardClaimsTable.guildId, guild.id),
      ))
      .limit(1);
    return racedClaim ?? null;
  }

  const configuredCredits = settings.topggSettingsConfigured ? settings.topggCreditsPerVote : settings.creditsPerVote;
  const requestedCredits = configuredCredits * event.weight;
  if (!Number.isSafeInteger(requestedCredits) || requestedCredits < 0) {
    throw new Error(`Invalid vote credit reward configured for guild ${guild.id}`);
  }

  return db.transaction(async (tx) => {
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
    if (!profile) throw new Error("Could not load vote-reward credit profile");

    const creditsAwarded = Math.min(requestedCredits, Math.max(0, MAX_CREDIT_BALANCE - profile.coins));
    const [claim] = await tx.insert(botVoteRewardClaimsTable)
      .values({
        voteId: event.voteId,
        platform: "topgg",
        guildId: guild.id,
        userId: member.id,
        claimStatus: "rewarded",
        creditsAwarded,
        roleId: settings.topggSettingsConfigured ? settings.topggRoleId : settings.roleId,
        roleDurationMs: settings.topggSettingsConfigured ? settings.topggRoleDurationMs : settings.roleDurationMs,
        roleStatus: (settings.topggSettingsConfigured ? settings.topggRoleId : settings.roleId) ? "pending_add" : "none",
        notificationStatus: "pending",
      })
      .onConflictDoNothing()
      .returning();

    if (!claim) {
      const [racedClaim] = await tx.select().from(botVoteRewardClaimsTable)
        .where(and(
          eq(botVoteRewardClaimsTable.voteId, event.voteId),
          eq(botVoteRewardClaimsTable.platform, "topgg"),
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
      eq(botVoteRewardClaimsTable.platform, "topgg"),
      eq(botVoteRewardClaimsTable.guildId, claim.guildId),
    ));
}

async function retryRole(claim: VoteClaim, error: unknown): Promise<void> {
  const attempts = claim.roleAttempts + 1;
  await updateClaim(claim, {
    roleAttempts: attempts,
    roleNextAttemptAt: Date.now() + retryDelay(attempts),
  });
  logger.warn({ err: error, guildId: claim.guildId, userId: claim.userId, roleId: claim.roleId, attempts }, "Top.gg vote role assignment will retry");
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
        logger.error({ guildId: guild.id, userId: claim.userId, roleId: claim.roleId }, "Configured Top.gg vote role is missing or managed");
        return;
      }
      if (member.roles.cache.has(role.id)) {
        const activeGrants = await getOtherActiveRoleGrants(claim);
        if (activeGrants.length === 0) {
          await updateClaim(claim, claim.roleAttempts > 0
            ? {
                roleStatus: "assigned",
                roleExpiresAt: claim.roleDurationMs ? Date.now() + claim.roleDurationMs : null,
                roleNextAttemptAt: 0,
              }
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

      await member.roles.add(role, "Top.gg vote reward");
      await updateClaim(claim, {
        roleStatus: "assigned",
        roleExpiresAt: claim.roleDurationMs ? Date.now() + claim.roleDurationMs : null,
        roleNextAttemptAt: 0,
      });
    } catch (error) {
      if (isUnknownMember(error)) {
        await updateClaim(claim, { roleStatus: "failed" });
        logger.warn({ guildId: claim.guildId, userId: claim.userId }, "Voter left the server before their vote role could be assigned");
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
        if (role) await member.roles.remove(role, "Top.gg temporary vote reward expired");
      }
      await updateClaim(claim, { roleStatus: "removed", roleExpiresAt: null, roleNextAttemptAt: 0 });
    } catch (error) {
      if (isUnknownMember(error)) {
        await updateClaim(claim, { roleStatus: "removed", roleExpiresAt: null, roleNextAttemptAt: 0 });
        return;
      }
      const attempts = claim.roleAttempts + 1;
      await updateClaim(claim, { roleAttempts: attempts, roleNextAttemptAt: Date.now() + retryDelay(attempts) });
      logger.warn({ err: error, guildId: claim.guildId, userId: claim.userId, roleId: claim.roleId }, "Temporary Top.gg vote role removal will retry");
    }
  }
}

async function notifyVoter(client: Client, claim: VoteClaim): Promise<void> {
  if (claim.notificationStatus !== "pending") return;
  const [reserved] = await db.update(botVoteRewardClaimsTable)
    .set({ notificationStatus: "sending", notificationUpdatedAt: new Date() })
    .where(and(
      eq(botVoteRewardClaimsTable.voteId, claim.voteId),
      eq(botVoteRewardClaimsTable.platform, "topgg"),
      eq(botVoteRewardClaimsTable.guildId, claim.guildId),
      eq(botVoteRewardClaimsTable.notificationStatus, "pending"),
    ))
    .returning({ voteId: botVoteRewardClaimsTable.voteId });
  if (!reserved) return;

  try {
    await sendVoteRewardNotification(client, claim, "topgg");
    await updateClaim(claim, { notificationStatus: "sent", notificationUpdatedAt: new Date() });
  } catch (error) {
    await updateClaim(claim, { notificationStatus: "unavailable", notificationUpdatedAt: new Date() });
    logger.info({ err: error, guildId: claim.guildId, userId: claim.userId, voteId: claim.voteId }, "Could not DM Top.gg vote reward; rewards remain processed");
  }
}

async function processVoteRoleClaims(client: Client): Promise<void> {
  const now = Date.now();
  const claims = await db.select().from(botVoteRewardClaimsTable)
    .where(and(
      eq(botVoteRewardClaimsTable.platform, "topgg"),
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
      eq(botVoteRewardClaimsTable.platform, "topgg"),
      eq(botVoteRewardClaimsTable.notificationStatus, "sending"),
      lte(botVoteRewardClaimsTable.notificationUpdatedAt, staleSendingBefore),
    ));
  const claims = await db.select().from(botVoteRewardClaimsTable)
    .where(and(
      eq(botVoteRewardClaimsTable.platform, "topgg"),
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