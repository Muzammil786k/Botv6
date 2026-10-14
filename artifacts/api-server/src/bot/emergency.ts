import {
  AuditLogEvent,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildBan,
  type GuildMember,
  type Message,
  type PartialUser,
  type Role,
  type User,
} from "discord.js";
import { and, eq } from "drizzle-orm";
import {
  botEmergencyQuarantinesTable,
  botEmergencyRolePermissionsTable,
  botEmergencySettingsTable,
  db,
} from "@workspace/db";
import { logger } from "../lib/logger";

const WINDOW_MS = 10 * 60_000;
const ACTION_LIMIT = 40;
const AUDIT_MATCH_MS = 15_000;
const actionWindows = new Map<string, number[]>();
const processedAuditEntries = new Map<string, number>();
let lastWindowCleanup = 0;

type EmergencyAction = "bans" | "kicks" | "everyone-pings";

async function getSettings(guildId: string) {
  const [settings] = await db.select()
    .from(botEmergencySettingsTable)
    .where(eq(botEmergencySettingsTable.guildId, guildId))
    .limit(1);
  return settings;
}

async function sendEmergencyLog(
  guild: Guild,
  logChannelId: string,
  title: string,
  description: string,
  color = 0xED4245,
): Promise<void> {
  const channel = await guild.channels.fetch(logChannelId).catch(() => null);
  if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) return;
  await channel.send({
    embeds: [new EmbedBuilder().setColor(color).setTitle(title).setDescription(description)],
    allowedMentions: { parse: [] },
  });
}

async function quarantineExecutor(
  guild: Guild,
  actorId: string,
  action: EmergencyAction,
  client: Client,
): Promise<void> {
  const settings = await getSettings(guild.id);
  if (!settings?.enabled) return;

  await db.update(botEmergencySettingsTable)
    .set({ emergencyActive: true, updatedAt: new Date() })
    .where(eq(botEmergencySettingsTable.guildId, guild.id));

  const [existingSnapshot] = await db.select({ userId: botEmergencyQuarantinesTable.userId })
    .from(botEmergencyQuarantinesTable)
    .where(and(
      eq(botEmergencyQuarantinesTable.guildId, guild.id),
      eq(botEmergencyQuarantinesTable.userId, actorId),
    ))
    .limit(1);
  if (existingSnapshot) return;

  if (actorId === guild.ownerId || actorId === client.user?.id) {
    await sendEmergencyLog(
      guild,
      settings.logChannelId,
      "Emergency Mode Activated",
      `Threshold reached for <@${actorId}> (${action}), but the server owner and bot account are protected from automatic quarantine.`,
    );
    return;
  }

  const member = guild.members.cache.get(actorId) ?? await guild.members.fetch(actorId).catch(() => null);
  const botMember = await guild.members.fetchMe().catch(() => null);
  if (!member || !botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    await sendEmergencyLog(
      guild,
      settings.logChannelId,
      "Emergency Mode Activated",
      `Threshold reached for <@${actorId}> (${action}), but I could not quarantine the executor. Check my Manage Roles permission and role position.`,
    );
    return;
  }

  const roleIds = member.roles.cache
    .filter((role) =>
      role.id !== guild.id &&
      !role.managed &&
      botMember.roles.highest.comparePositionTo(role) > 0,
    )
    .map((role) => role.id);

  const [saved] = await db.insert(botEmergencyQuarantinesTable)
    .values({ guildId: guild.id, userId: actorId, roleIds })
    .onConflictDoNothing()
    .returning({ userId: botEmergencyQuarantinesTable.userId });
  if (!saved) return;

  try {
    if (roleIds.length > 0) {
      await member.roles.remove(roleIds, `Auto emergency threshold reached: ${action}`);
    }
    await sendEmergencyLog(
      guild,
      settings.logChannelId,
      "Emergency Mode Activated",
      `Threshold reached: <@${actorId}> caused **${action}** to reach ${ACTION_LIMIT} events in 10 minutes. Removed ${roleIds.length} assignable role(s). Use owner-only \`!auto emergency restore\` to restore snapshots.`,
    );
  } catch (error) {
    logger.error({ err: error, guildId: guild.id, actorId }, "Auto emergency quarantine failed");
    await sendEmergencyLog(
      guild,
      settings.logChannelId,
      "Emergency Quarantine Failed",
      `Threshold reached for <@${actorId}> (${action}), but role removal failed. Check my Manage Roles permission and role position.`,
    );
  }
}

async function recordAction(
  guild: Guild,
  actorId: string,
  action: EmergencyAction,
  client: Client,
): Promise<void> {
  if (!actorId || actorId === client.user?.id) return;
  const settings = await getSettings(guild.id);
  if (!settings?.enabled) return;

  const key = `${guild.id}:${actorId}:${action}`;
  const now = Date.now();
  if (now - lastWindowCleanup >= 60_000) {
    for (const [windowKey, events] of actionWindows) {
      const recentEvents = events.filter((time) => now - time < WINDOW_MS);
      if (recentEvents.length > 0) actionWindows.set(windowKey, recentEvents);
      else actionWindows.delete(windowKey);
    }
    lastWindowCleanup = now;
  }
  const timestamps = (actionWindows.get(key) ?? []).filter((time) => now - time < WINDOW_MS);
  timestamps.push(now);
  actionWindows.set(key, timestamps);

  if (timestamps.length === ACTION_LIMIT) {
    await quarantineExecutor(guild, actorId, action, client);
  }
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function findAuditExecutor(
  guild: Guild,
  auditType: AuditLogEvent,
  targetId: string,
): Promise<{ executorId: string; entryId: string } | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const logs = await guild.fetchAuditLogs({ type: auditType, limit: 10 }).catch(() => null);
    const now = Date.now();
    const entry = logs?.entries.find((candidate) =>
      candidate.targetId === targetId &&
      now - candidate.createdTimestamp <= AUDIT_MATCH_MS,
    );
    if (entry?.executorId) return { executorId: entry.executorId, entryId: entry.id };
    if (attempt < 2) await wait(600);
  }
  return null;
}

async function recordAuditAction(
  guild: Guild,
  targetId: string,
  auditType: AuditLogEvent,
  action: "bans" | "kicks",
  client: Client,
): Promise<void> {
  const settings = await getSettings(guild.id);
  if (!settings?.enabled) return;

  const match = await findAuditExecutor(guild, auditType, targetId);
  if (!match) return;

  const now = Date.now();
  for (const [entryId, timestamp] of processedAuditEntries) {
    if (now - timestamp >= WINDOW_MS) processedAuditEntries.delete(entryId);
  }
  if (processedAuditEntries.has(match.entryId)) return;
  processedAuditEntries.set(match.entryId, now);
  await recordAction(guild, match.executorId, action, client);
}

export async function handleEmergencyBanAdd(client: Client, ban: GuildBan): Promise<void> {
  await recordAuditAction(ban.guild, ban.user.id, AuditLogEvent.MemberBanAdd, "bans", client);
}

export async function handleEmergencyMemberRemove(client: Client, member: GuildMember): Promise<void> {
  await recordAuditAction(member.guild, member.id, AuditLogEvent.MemberKick, "kicks", client);
}

export async function handleEmergencyEveryonePing(client: Client, message: Message): Promise<void> {
  if (!message.guild || !message.mentions.everyone || message.author.id === client.user?.id) return;
  await recordAction(message.guild, message.author.id, "everyone-pings", client);
}

export async function handleEmergencyRoleUpdate(oldRole: Role, newRole: Role): Promise<void> {
  const removedPermissions = oldRole.permissions.bitfield & ~newRole.permissions.bitfield;
  if (removedPermissions === 0n) return;

  const settings = await getSettings(newRole.guild.id);
  if (!settings?.emergencyActive) return;

  const [captured] = await db.insert(botEmergencyRolePermissionsTable)
    .values({
      guildId: newRole.guild.id,
      roleId: newRole.id,
      permissions: oldRole.permissions.bitfield.toString(),
    })
    .onConflictDoNothing()
    .returning({ roleId: botEmergencyRolePermissionsTable.roleId });
  if (!captured) return;

  await sendEmergencyLog(
    newRole.guild,
    settings.logChannelId,
    "Role Permissions Changed During Emergency",
    `Saved the previous permissions for **${newRole.name}**. The owner can restore them with \`!auto emergency restore\`.`,
    0xFEE75C,
  );
}

async function restoreEmergencySnapshots(guild: Guild): Promise<{ restoredMembers: number; restoredRoles: number; pending: number }> {
  const botMember = await guild.members.fetchMe().catch(() => null);
  if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    throw new Error("I need Manage Roles permission to restore emergency snapshots.");
  }

  const memberSnapshots = await db.select()
    .from(botEmergencyQuarantinesTable)
    .where(eq(botEmergencyQuarantinesTable.guildId, guild.id));
  const roleSnapshots = await db.select()
    .from(botEmergencyRolePermissionsTable)
    .where(eq(botEmergencyRolePermissionsTable.guildId, guild.id));

  let restoredMembers = 0;
  let restoredRoles = 0;
  let pending = 0;

  for (const snapshot of memberSnapshots) {
    const member = guild.members.cache.get(snapshot.userId) ?? await guild.members.fetch(snapshot.userId).catch(() => null);
    if (!member) {
      pending++;
      continue;
    }

    const rolesToRestore: string[] = [];
    let hasUnassignableRoles = false;
    for (const roleId of snapshot.roleIds) {
      const role = guild.roles.cache.get(roleId) ?? await guild.roles.fetch(roleId).catch(() => null);
      if (!role || member.roles.cache.has(roleId)) continue;
      if (role.managed || botMember.roles.highest.comparePositionTo(role) <= 0) {
        hasUnassignableRoles = true;
        continue;
      }
      rolesToRestore.push(roleId);
    }

    try {
      if (rolesToRestore.length > 0) {
        await member.roles.add(rolesToRestore, "Owner requested auto emergency restore");
        restoredMembers++;
      }
      if (hasUnassignableRoles) {
        pending++;
      } else {
        await db.delete(botEmergencyQuarantinesTable)
          .where(and(
            eq(botEmergencyQuarantinesTable.guildId, guild.id),
            eq(botEmergencyQuarantinesTable.userId, snapshot.userId),
          ));
      }
    } catch (error) {
      logger.warn({ err: error, guildId: guild.id, userId: snapshot.userId }, "Could not restore quarantined member roles");
      pending++;
    }
  }

  for (const snapshot of roleSnapshots) {
    const role = guild.roles.cache.get(snapshot.roleId) ?? await guild.roles.fetch(snapshot.roleId).catch(() => null);
    if (!role) {
      await db.delete(botEmergencyRolePermissionsTable)
        .where(and(
          eq(botEmergencyRolePermissionsTable.guildId, guild.id),
          eq(botEmergencyRolePermissionsTable.roleId, snapshot.roleId),
        ));
      continue;
    }
    if (role.managed || botMember.roles.highest.comparePositionTo(role) <= 0) {
      pending++;
      continue;
    }

    try {
      await role.setPermissions(BigInt(snapshot.permissions), "Owner requested auto emergency restore");
      await db.delete(botEmergencyRolePermissionsTable)
        .where(and(
          eq(botEmergencyRolePermissionsTable.guildId, guild.id),
          eq(botEmergencyRolePermissionsTable.roleId, snapshot.roleId),
        ));
      restoredRoles++;
    } catch (error) {
      logger.warn({ err: error, guildId: guild.id, roleId: snapshot.roleId }, "Could not restore role permissions");
      pending++;
    }
  }

  return { restoredMembers, restoredRoles, pending };
}

export async function handleAutoEmergencyCommand(message: Message): Promise<void> {
  const guild = message.guild;
  if (!guild) return;
  const action = message.content.trim().split(/\s+/)[2]?.toLowerCase();

  if (action === "restore") {
    if (message.author.id !== guild.ownerId) {
      await message.reply({
        content: "Only the server owner can restore auto emergency snapshots.",
        allowedMentions: { parse: [], repliedUser: false },
      });
      return;
    }

    try {
      const settings = await getSettings(guild.id);
      if (!settings) {
        await message.reply({ content: "Auto emergency has no saved settings.", allowedMentions: { parse: [], repliedUser: false } });
        return;
      }
      const result = await restoreEmergencySnapshots(guild);
      await db.update(botEmergencySettingsTable)
        .set({ emergencyActive: result.pending > 0, updatedAt: new Date() })
        .where(eq(botEmergencySettingsTable.guildId, guild.id));
      await message.reply({
        content: `Restored roles for ${result.restoredMembers} member(s) and permissions for ${result.restoredRoles} role(s). Pending hierarchy/member issues: ${result.pending}.`,
        allowedMentions: { parse: [], repliedUser: false },
      });
      await sendEmergencyLog(
        guild,
        settings.logChannelId,
        "Emergency Restore Requested",
        `Owner restored ${result.restoredMembers} member role set(s) and ${result.restoredRoles} role permission set(s). Pending: ${result.pending}.`,
        0x57F287,
      );
    } catch (error) {
      logger.error({ err: error, guildId: guild.id }, "Auto emergency restore failed");
      await message.reply({ content: "Could not restore emergency snapshots. Check my Manage Roles permission and hierarchy.", allowedMentions: { parse: [], repliedUser: false } });
    }
    return;
  }

  const member = message.member ?? await guild.members.fetch(message.author.id).catch(() => null);
  if (!member?.permissions.has(PermissionFlagsBits.ManageGuild)) {
    await message.reply({ content: "You need Manage Server permission to configure auto emergency.", allowedMentions: { parse: [], repliedUser: false } });
    return;
  }

  if (action === "enable") {
    const channel = message.channel;
    if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
      await message.reply({ content: "Run this command in a server text channel to use it as the emergency log channel.", allowedMentions: { parse: [], repliedUser: false } });
      return;
    }
    const botMember = await guild.members.fetchMe().catch(() => null);
    if (!botMember?.permissions.has([PermissionFlagsBits.ViewAuditLog, PermissionFlagsBits.ManageRoles])) {
      await message.reply({ content: "I need **View Audit Log** and **Manage Roles** permissions to enable auto emergency.", allowedMentions: { parse: [], repliedUser: false } });
      return;
    }
    const channelPermissions = channel.permissionsFor(botMember);
    if (!channelPermissions?.has([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
    ])) {
      await message.reply({ content: "I need **View Channel**, **Send Messages**, and **Embed Links** in this channel for emergency logs.", allowedMentions: { parse: [], repliedUser: false } });
      return;
    }

    await db.insert(botEmergencySettingsTable)
      .values({ guildId: guild.id, enabled: true, logChannelId: channel.id })
      .onConflictDoUpdate({
        target: botEmergencySettingsTable.guildId,
        set: { enabled: true, logChannelId: channel.id, updatedAt: new Date() },
      });
    await message.reply({ content: `Auto emergency enabled. Logs will be sent to ${channel}. I will quarantine an executor at 40 bans, 40 kicks, or 40 @everyone/@here pings of the same type within 10 minutes.`, allowedMentions: { parse: [], repliedUser: false } });
    return;
  }

  if (action === "disable") {
    const settings = await getSettings(guild.id);
    if (!settings) {
      await message.reply({ content: "Auto emergency is not configured. Use `!auto emergency enable` first.", allowedMentions: { parse: [], repliedUser: false } });
      return;
    }
    await db.update(botEmergencySettingsTable)
      .set({ enabled: false, updatedAt: new Date() })
      .where(eq(botEmergencySettingsTable.guildId, guild.id));
    await message.reply({ content: settings.emergencyActive
      ? "Auto emergency monitoring disabled. Existing snapshots remain; the owner can run `!auto emergency restore`."
      : "Auto emergency monitoring disabled.", allowedMentions: { parse: [], repliedUser: false } });
    return;
  }

  if (action === "status") {
    const settings = await getSettings(guild.id);
    await message.reply({
      content: settings
        ? `Monitoring: ${settings.enabled ? "enabled" : "disabled"} · Emergency active: ${settings.emergencyActive ? "yes" : "no"} · Logs: <#${settings.logChannelId}>`
        : "Auto emergency is not configured. Use `!auto emergency enable`.",
      allowedMentions: { parse: [], repliedUser: false },
    });
    return;
  }

  await message.reply({
    content: "Usage: `!auto emergency enable`, `!auto emergency disable`, `!auto emergency status`, or owner-only `!auto emergency restore`.",
    allowedMentions: { parse: [], repliedUser: false },
  });
}