import { EmbedBuilder, PermissionFlagsBits, type Message } from "discord.js";
import { eq } from "drizzle-orm";
import { botVoteRewardSettingsTable, db, type VoteRewardEmbedTemplate } from "@workspace/db";
import { logger } from "../lib/logger";
import { getVoteRewardStats } from "./topggVotes";
import {
  buildVoteRewardMessage,
  getVoteRewardEmbedFieldKey,
  loadVoteRewardEmbedTemplate,
  validateVoteRewardEmbedField,
  type VotePlatform,
} from "./voteRewardEmbeds";

const MAX_CREDITS_PER_VOTE = 1_000_000;
const MAX_TEMP_ROLE_DURATION_MS = 365 * 24 * 60 * 60_000;
const COLOR = 0xff3366;

type EmbedTemplateTarget = "shared" | VotePlatform;

function reply(message: Message, title: string, description: string): Promise<unknown> {
  return message.reply({ embeds: [new EmbedBuilder().setColor(COLOR).setTitle(title).setDescription(description)] });
}

function parseDuration(value: string | undefined): number | null {
  const match = /^([0-9]+)(m|h|d)$/i.exec(value ?? "");
  if (!match) return null;
  const multiplier = match[2]!.toLowerCase() === "m" ? 60_000 : match[2]!.toLowerCase() === "h" ? 3_600_000 : 86_400_000;
  const duration = Number(match[1]) * multiplier;
  return Number.isSafeInteger(duration) && duration > 0 && duration <= MAX_TEMP_ROLE_DURATION_MS ? duration : null;
}

async function requireVoteRewardAdmin(message: Message): Promise<boolean> {
  const guild = message.guild;
  if (!guild) return false;
  const member = message.member ?? await guild.members.fetch(message.author.id).catch(() => null);
  if (
    message.author.id === process.env.BOT_OWNER_ID ||
    member?.permissions.has(PermissionFlagsBits.ManageGuild) ||
    member?.permissions.has(PermissionFlagsBits.Administrator)
  ) return true;
  await reply(message, "Vote rewards", "❌ You need **Manage Server** permission to configure vote rewards.");
  return false;
}

function getPlatformConfig(platform: VotePlatform) {
  if (platform === "discadia") {
    return {
      platformLabel: "Discadia",
      enabled: "discadiaEnabled",
      credits: "discadiaCreditsPerVote",
      roleId: "discadiaRoleId",
      roleDuration: "discadiaRoleDurationMs",
    } as const;
  }

  return {
    platformLabel: "Top.gg",
    enabled: "topggEnabled",
    credits: "topggCreditsPerVote",
    roleId: "topggRoleId",
    roleDuration: "topggRoleDurationMs",
  } as const;
}

async function loadSettings(guildId: string, platform: VotePlatform) {
  const [settings] = await db.select().from(botVoteRewardSettingsTable)
    .where(eq(botVoteRewardSettingsTable.guildId, guildId))
    .limit(1);
  if (!settings) return null;

  if (platform === "discadia") {
    return {
      enabled: settings.discadiaEnabled,
      creditsPerVote: settings.discadiaCreditsPerVote,
      roleId: settings.discadiaRoleId,
      roleDurationMs: settings.discadiaRoleDurationMs,
    };
  }

  return {
    enabled: settings.topggSettingsConfigured ? settings.topggEnabled : settings.topggEnabled || settings.enabled,
    creditsPerVote: settings.topggSettingsConfigured ? settings.topggCreditsPerVote : settings.creditsPerVote,
    roleId: settings.topggSettingsConfigured ? settings.topggRoleId : settings.topggRoleId ?? settings.roleId,
    roleDurationMs: settings.topggSettingsConfigured ? settings.topggRoleDurationMs : settings.topggRoleDurationMs ?? settings.roleDurationMs,
  };
}

async function saveSettings(
  guildId: string,
  updatedBy: string,
  platform: VotePlatform,
  values: Partial<typeof botVoteRewardSettingsTable.$inferInsert>,
): Promise<void> {
  const config = getPlatformConfig(platform);
  if (platform === "discadia") {
    await db.insert(botVoteRewardSettingsTable)
      .values({
        guildId,
        updatedBy,
        discadiaEnabled: values.enabled ?? false,
        discadiaCreditsPerVote: values.creditsPerVote ?? 100,
        discadiaRoleId: values.roleId ?? null,
        discadiaRoleDurationMs: values.roleDurationMs ?? null,
      })
      .onConflictDoUpdate({
        target: botVoteRewardSettingsTable.guildId,
        set: {
          discadiaEnabled: values.enabled ?? false,
          discadiaCreditsPerVote: values.creditsPerVote ?? 100,
          discadiaRoleId: values.roleId ?? null,
          discadiaRoleDurationMs: values.roleDurationMs ?? null,
          updatedBy,
          updatedAt: new Date(),
        },
      });
    return;
  }

  await db.insert(botVoteRewardSettingsTable)
    .values({
      guildId,
      updatedBy,
      enabled: values.enabled ?? false,
      topggEnabled: values.enabled ?? false,
      topggSettingsConfigured: true,
      topggCreditsPerVote: values.creditsPerVote ?? 100,
      topggRoleId: values.roleId ?? null,
      topggRoleDurationMs: values.roleDurationMs ?? null,
    })
    .onConflictDoUpdate({
      target: botVoteRewardSettingsTable.guildId,
      set: {
        enabled: values.enabled ?? false,
        topggEnabled: values.enabled ?? false,
        topggSettingsConfigured: true,
        topggCreditsPerVote: values.creditsPerVote ?? 100,
        topggRoleId: values.roleId ?? null,
        topggRoleDurationMs: values.roleDurationMs ?? null,
        updatedBy,
        updatedAt: new Date(),
      },
    });
}

  async function loadStoredEmbedTemplate(guildId: string, target: EmbedTemplateTarget): Promise<VoteRewardEmbedTemplate> {
    if (target === "shared") return loadVoteRewardEmbedTemplate(guildId, "shared");
    const [settings] = await db.select().from(botVoteRewardSettingsTable)
      .where(eq(botVoteRewardSettingsTable.guildId, guildId))
      .limit(1);
    return target === "topgg"
      ? { ...(settings?.topggVoteEmbedTemplate ?? {}) }
      : { ...(settings?.discadiaVoteEmbedTemplate ?? {}) };
  }

  async function saveEmbedTemplate(
    guildId: string,
    updatedBy: string,
    target: EmbedTemplateTarget,
    template: VoteRewardEmbedTemplate,
  ): Promise<void> {
    if (target === "shared") {
      await db.insert(botVoteRewardSettingsTable)
        .values({ guildId, updatedBy, voteEmbedTemplate: template })
        .onConflictDoUpdate({
          target: botVoteRewardSettingsTable.guildId,
          set: { voteEmbedTemplate: template, updatedBy, updatedAt: new Date() },
        });
      return;
    }

    if (target === "topgg") {
      await db.insert(botVoteRewardSettingsTable)
        .values({ guildId, updatedBy, topggVoteEmbedTemplate: template })
        .onConflictDoUpdate({
          target: botVoteRewardSettingsTable.guildId,
          set: { topggVoteEmbedTemplate: template, updatedBy, updatedAt: new Date() },
        });
      return;
    }

    await db.insert(botVoteRewardSettingsTable)
      .values({ guildId, updatedBy, discadiaVoteEmbedTemplate: template })
      .onConflictDoUpdate({
        target: botVoteRewardSettingsTable.guildId,
        set: { discadiaVoteEmbedTemplate: template, updatedBy, updatedAt: new Date() },
      });
  }

async function saveVoteRewardChannel(guildId: string, updatedBy: string, channelId: string | null): Promise<void> {
  await db.insert(botVoteRewardSettingsTable)
    .values({ guildId, updatedBy, voteRewardChannelId: channelId })
    .onConflictDoUpdate({
      target: botVoteRewardSettingsTable.guildId,
      set: { voteRewardChannelId: channelId, updatedBy, updatedAt: new Date() },
    });
}

export async function handleVoteRewardCommand(message: Message, args: string[]): Promise<void> {
  const guild = message.guild;
  if (!guild || !(await requireVoteRewardAdmin(message))) return;

  const channelCommandIndex = args[0]?.toLowerCase() === "channel"
    ? 0
    : (args[0]?.toLowerCase() === "topgg" || args[0]?.toLowerCase() === "discadia") && args[1]?.toLowerCase() === "channel"
      ? 1
      : -1;
  if (channelCommandIndex >= 0) {
    const channelInput = args[channelCommandIndex + 1];
    if (!channelInput) {
      const [settings] = await db.select().from(botVoteRewardSettingsTable)
        .where(eq(botVoteRewardSettingsTable.guildId, guild.id))
        .limit(1);
      const channelId = settings?.voteRewardChannelId;
      if (!channelId) {
        await reply(message, "Vote reward channel", "Vote channel announcements are disabled. Reward notifications continue by DM.");
        return;
      }
      const channel = await guild.channels.fetch(channelId).catch(() => null);
      await reply(message, "Vote reward channel", channel
        ? `Vote reward embeds will be posted in ${channel}.`
        : `Configured channel <#${channelId}> is unavailable. Set another channel or use \`!votereward channel none\`.`);
      return;
    }

    if (["none", "disable", "off"].includes(channelInput.toLowerCase())) {
      await saveVoteRewardChannel(guild.id, message.author.id, null);
      await reply(message, "Vote reward channel", "Vote channel announcements are disabled. Reward notifications continue by DM.");
      return;
    }

    const channelId = message.mentions.channels.first()?.id ?? /^<#(\d{17,20})>$/.exec(channelInput)?.[1] ?? (/^\d{17,20}$/.test(channelInput) ? channelInput : null);
    if (!channelId) {
      await reply(message, "Vote reward channel", "Usage: `!votereward channel #channel`, `!votereward channel <channel-id>`, or `!votereward channel none`.");
      return;
    }
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased() || !channel.isSendable()) {
      await reply(message, "Vote reward channel", "That channel is unavailable or cannot receive text messages.");
      return;
    }
    const botMember = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
    const permissions = botMember ? channel.permissionsFor(botMember) : null;
    if (!permissions || !permissions.has(PermissionFlagsBits.ViewChannel) || !permissions.has(PermissionFlagsBits.SendMessages)) {
      await reply(message, "Vote reward channel", "I need **View Channel** and **Send Messages** permissions in that channel.");
      return;
    }
    await saveVoteRewardChannel(guild.id, message.author.id, channel.id);
    await reply(message, "Vote reward channel", `Vote reward embeds will be posted in ${channel}.`);
    return;
  }

  if (args[0]?.toLowerCase() === "embed") {
    const rawTarget = args[1]?.toLowerCase() ?? "shared";
    const target = rawTarget === "default" ? "shared" : rawTarget;
    if (target !== "shared" && target !== "topgg" && target !== "discadia") {
      await reply(message, "Vote reward embeds", "Choose `shared`, `topgg`, or `discadia` as the template.");
      return;
    }

    const action = args[2]?.toLowerCase() ?? "preview";
    if (action === "reset") {
      await saveEmbedTemplate(guild.id, message.author.id, target, {});
      await reply(message, "Vote reward embeds", `The ${target} embed template was reset${target === "shared" ? " to built-in defaults" : " to inherit the shared template"}.`);
      return;
    }

    if (action === "set") {
      const field = args[3] ?? "";
      const value = args.slice(4).join(" ");
      if (!field || !value) {
        await reply(message, "Vote reward embeds", "Usage: `!votereward embed <shared|topgg|discadia> set <field> <value>`.");
        return;
      }
      const current = await loadVoteRewardEmbedTemplate(guild.id, target);
      if (value.toLowerCase() === "none") {
        const template = await loadStoredEmbedTemplate(guild.id, target);
        const key = getVoteRewardEmbedFieldKey(field);
        if (!key) {
          await reply(message, "Vote reward embeds", "Unknown field. Use `title`, `description`, `color`, `author`, `authoricon`, `footer`, `footericon`, `thumbnail`, `image`, `success`, `topggurl`, or `discadiaurl`.");
          return;
        }
        delete template[key];
        await saveEmbedTemplate(guild.id, message.author.id, target, template);
        await reply(message, "Vote reward embeds", `Cleared **${field}** for the ${target} template${target === "shared" ? "." : "; it now inherits the shared value."}`);
        return;
      }
      const parsed = validateVoteRewardEmbedField(field, value);
      if (!parsed) {
        await reply(message, "Vote reward embeds", "Invalid field or value. Colors must be `#RRGGBB`; image/icon/button links must be HTTP(S) URLs; text must fit Discord's field limits.");
        return;
      }
      const template = target === "shared" ? current : await loadStoredEmbedTemplate(guild.id, target);
      template[parsed.key] = parsed.value;
      await saveEmbedTemplate(guild.id, message.author.id, target, template);
      await reply(message, "Vote reward embeds", `Saved **${field}** for the ${target} template.`);
      return;
    }

    if (action === "preview") {
      const template = await loadVoteRewardEmbedTemplate(guild.id, target);
      const platform: VotePlatform = target === "discadia" ? "discadia" : "topgg";
      const platformSettings = await loadSettings(guild.id, platform);
      const preview = buildVoteRewardMessage(template, {
        user: `<@${message.author.id}>`,
        username: message.author.username,
        credits: platformSettings?.creditsPerVote ?? 100,
        role: platformSettings?.roleId ? ` <@&${platformSettings.roleId}>` : " No role reward configured.",
        platform: target === "shared" ? "Top.gg / Discadia" : getPlatformConfig(platform).platformLabel,
        server: guild.name,
      });
      await message.reply(preview);
      return;
    }

    await reply(message, "Vote reward embeds", "Use `!votereward embed <shared|topgg|discadia> set|preview|reset ...`.");
    return;
  }

  const preferredPlatform: VotePlatform = args[0]?.toLowerCase() === "discadia" ? "discadia" : "topgg";
  const commandArgs = args[0]?.toLowerCase() === "topgg" || preferredPlatform === "discadia" ? args.slice(1) : args;
  const action = commandArgs[0]?.toLowerCase() ?? "status";
  const platformLabel = getPlatformConfig(preferredPlatform).platformLabel;

  if (action === "enable" || action === "disable") {
    const enabled = action === "enable";
    const current = await loadSettings(guild.id, preferredPlatform);
    await saveSettings(guild.id, message.author.id, preferredPlatform, {
      enabled,
      creditsPerVote: current?.creditsPerVote ?? 100,
      roleId: current?.roleId ?? null,
      roleDurationMs: current?.roleDurationMs ?? null,
    });
    await reply(message, "Vote rewards", `✅ ${platformLabel} vote rewards ${enabled ? "enabled" : "disabled"} in this server.`);
    return;
  }

  if (action === "credits") {
    const amount = Number(commandArgs[1]);
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > MAX_CREDITS_PER_VOTE) {
      await reply(message, "Vote rewards", `Usage: \`!votereward ${preferredPlatform === "discadia" ? "discadia" : "topgg"} credits <0-${MAX_CREDITS_PER_VOTE.toLocaleString()}>\`.`);
      return;
    }
    const current = await loadSettings(guild.id, preferredPlatform);
    await saveSettings(guild.id, message.author.id, preferredPlatform, {
      enabled: current?.enabled ?? false,
      creditsPerVote: amount,
      roleId: current?.roleId ?? null,
      roleDurationMs: current?.roleDurationMs ?? null,
    });
    await reply(message, "Vote rewards", `✅ Credit reward set to **${amount} credits per vote** for ${platformLabel}.`);
    return;
  }

  if (action === "role") {
    const roleInput = commandArgs[1];
    if (roleInput?.toLowerCase() === "none") {
      const current = await loadSettings(guild.id, preferredPlatform);
      await saveSettings(guild.id, message.author.id, preferredPlatform, {
        enabled: current?.enabled ?? false,
        creditsPerVote: current?.creditsPerVote ?? 100,
        roleId: null,
        roleDurationMs: null,
      });
      await reply(message, "Vote rewards", `✅ ${platformLabel} vote role reward removed.`);
      return;
    }

    const roleId = message.mentions.roles.first()?.id ?? /^<@&?(\d{17,20})>$/.exec(roleInput ?? "")?.[1] ?? (/^\d{17,20}$/.test(roleInput ?? "") ? roleInput : null);
    const durationInput = commandArgs[2]?.toLowerCase();
    const roleDurationMs = durationInput === "permanent" ? null : parseDuration(durationInput);
    if (!roleId || (durationInput !== "permanent" && roleDurationMs === null)) {
      await reply(message, "Vote rewards", `Usage: \`!votereward ${preferredPlatform} role <role-id> permanent\` or \`!votereward ${preferredPlatform} role <role-id> 7d\``);
      return;
    }

    const role = await guild.roles.fetch(roleId).catch(() => null);
    const botMember = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
    if (!role || role.managed || role.id === guild.id) {
      await reply(message, "Vote rewards", "❌ That role is unavailable or cannot be assigned by a bot.");
      return;
    }
    if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles) || botMember.roles.highest.comparePositionTo(role) <= 0) {
      await reply(message, "Vote rewards", "❌ Give the bot **Manage Roles** and move its highest role above the reward role before configuring it.");
      return;
    }

    const current = await loadSettings(guild.id, preferredPlatform);
    await saveSettings(guild.id, message.author.id, preferredPlatform, {
      enabled: current?.enabled ?? false,
      creditsPerVote: current?.creditsPerVote ?? 100,
      roleId: role.id,
      roleDurationMs,
    });
    await reply(message, "Vote rewards", `✅ ${platformLabel} vote role set to ${role} (${roleDurationMs === null ? "permanent" : `expires after ${durationInput}`} on each vote).`);
    return;
  }

  if (action === "status") {
    const current = await loadSettings(guild.id, preferredPlatform);
    if (!current) {
      await reply(message, "Vote rewards", `This server has no ${platformLabel} vote reward configuration yet. Use \`!votereward ${preferredPlatform} credits <amount>\`, then \`!votereward ${preferredPlatform} enable\`.`);
      return;
    }
    const roleSetting = current.roleId
      ? `<@&${current.roleId}> (${current.roleDurationMs === null ? "permanent" : `temporary: ${Math.round(current.roleDurationMs / 60_000)} minutes`})`
      : "none";
    await reply(message, `${platformLabel} vote reward settings`, `Status: **${current.enabled ? "enabled" : "disabled"}**\nCredits: **${current.creditsPerVote} per vote**\nRole: ${roleSetting}`);
    return;
  }

  if (action === "stats") {
    const stats = await getVoteRewardStats(guild.id, preferredPlatform);
    await reply(message, `${platformLabel} vote statistics`, `Eligible votes rewarded: **${stats.votes.toLocaleString()}**\nCredits awarded: **${stats.credits.toLocaleString()}**`);
    return;
  }

  if (action === "help") {
    await reply(message, "Vote rewards", [
      "`!votereward topgg enable|disable` — toggle Top.gg rewards",
      "`!votereward discadia enable|disable` — toggle Discadia rewards",
      "`!votereward topgg credits <amount>` / `!votereward discadia credits <amount>` — credits per vote",
      "`!votereward topgg role <role-id> permanent|<duration>` / `!votereward discadia role <role-id> permanent|<duration>` — set the role reward",
      "`!votereward topgg status|stats` / `!votereward discadia status|stats` — inspect settings",
      "`!votereward channel #channel|<id>` — set the shared vote announcement channel; use `channel` to view it or `channel none` to disable channel posts",
      "`!votereward embed <shared|topgg|discadia> set <field> <value>` — customize vote reward messages",
      "`!votereward embed <shared|topgg|discadia> preview|reset` — preview or reset a template",
    ].join("\n"));
    return;
  }

  logger.warn({ guildId: guild.id, action, preferredPlatform }, "Unknown vote reward command action");
  await reply(message, "Vote rewards", "Use `!votereward help` to see available settings.");
}

export async function handleTopggVoteRewardCommand(message: Message, args: string[]): Promise<void> {
  await handleVoteRewardCommand(message, args);
}
