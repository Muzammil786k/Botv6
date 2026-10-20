import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  PermissionFlagsBits,
  type Message,
  type TextChannel,
} from "discord.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { premiumEmbed, premiumMessagePayload } from "./presentation";
import { releaseModerationAction, reserveModerationAction } from "./moderationLimits";

const C = 0x2b2d31;
const DATA_DIR = join(process.cwd(), "data");
const AUTOMOD_FILE = join(DATA_DIR, "automod.json");

interface AutomodConfig {
  invites: boolean;
  links: boolean;
  linksConfigured?: boolean;
  mentionLimit: number;
  blacklist: string[];
  blockedDomains: string[];
  allowedDomains: string[];
}

const DEFAULT_AUTOMOD: AutomodConfig = {
  invites: true,
  links: false,
  linksConfigured: false,
  mentionLimit: 5,
  blacklist: ["discord.gg", "freenitro", "nitrofree", "free nitro"],
  blockedDomains: [],
  allowedDomains: [],
};

const automodConfig = new Map<string, AutomodConfig>();

function ensureAutomodDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function loadAutomodConfig(): Record<string, AutomodConfig> {
  try {
    if (!existsSync(AUTOMOD_FILE)) return {};
    return JSON.parse(readFileSync(AUTOMOD_FILE, "utf-8")) as Record<string, AutomodConfig>;
  } catch {
    return {};
  }
}

function saveAutomodConfig(data: Record<string, AutomodConfig>): void {
  ensureAutomodDir();
  writeFileSync(AUTOMOD_FILE, JSON.stringify(data, null, 2));
}

function getAutomodConfig(guildId: string): AutomodConfig {
  const savedConfig = automodConfig.get(guildId) ?? loadAutomodConfig()[guildId];
  const saved = savedConfig
    ? { ...DEFAULT_AUTOMOD, ...savedConfig }
    : DEFAULT_AUTOMOD;
  if (savedConfig && savedConfig.linksConfigured !== true) saved.links = false;
  automodConfig.set(guildId, saved);
  return saved;
}

function persistAutomodConfig(guildId: string, config: AutomodConfig): void {
  const store = loadAutomodConfig();
  store[guildId] = config;
  automodConfig.set(guildId, config);
  saveAutomodConfig(store);
}

function sanitizeWord(word: string): string {
  return word.trim().toLowerCase().replace(/\s+/g, " ");
}

function formatAutomodList(values: string[]): string {
  const formatted = values.join(", ") || "None";
  return formatted.length > 1_000 ? `${formatted.slice(0, 997)}...` : formatted;
}

function sanitizeDomain(value: string): string | null {
  const input = value.trim().toLowerCase();
  if (!input) return null;

  try {
    const url = new URL(input.includes("://") ? input : `https://${input}`);
    const hostname = url.hostname.replace(/^www\./, "").replace(/\.$/, "");
    if (!hostname.includes(".") || hostname.includes(" ")) return null;
    return hostname;
  } catch {
    return null;
  }
}

function domainMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function getLinkHosts(content: string): string[] {
  const matches = content.match(/(?:https?:\/\/|www\.)[^\s<>]+/gi) ?? [];
  return matches.flatMap((match) => {
    try {
      const url = new URL(match.startsWith("www.") ? `https://${match}` : match);
      return [url.hostname.toLowerCase().replace(/\.$/, "")];
    } catch {
      return [];
    }
  });
}

function escapeReason(value: string): string {
  return value.replace(/[`*_~]/g, "");
}

async function applyAutomodAction(message: Message, reason: string): Promise<void> {
  if (!message.guild) return;
  if (message.member?.permissions.has(PermissionFlagsBits.ManageGuild) || message.member?.permissions.has(PermissionFlagsBits.Administrator)) {
    return;
  }

  await message.delete().catch(() => {});

  try {
    await message.author.send({
      embeds: [
        new EmbedBuilder()
          .setColor(C)
          .setTitle(`⚠️ Warning in ${message.guild.name}`)
          .setDescription(`Your message was removed for: **${escapeReason(reason)}**`),
      ],
    });
  } catch {
    // DMs closed
  }
}

// ─── Kick ──────────────────────────────────────────────────────────────────────

export async function handleKick(message: Message): Promise<void> {
  if (!message.guild) return;
  const mod = message.member ?? await message.guild.members.fetch(message.author.id).catch(() => null);
  if (!mod?.permissions.has(PermissionFlagsBits.KickMembers)) {
    await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription("❌ You need **Kick Members** permission.")] });
    return;
  }
  const args = message.content.trim().split(/\s+/).slice(1);
  const target = message.mentions.members?.first() ?? (args[0] ? await message.guild.members.fetch(args[0]).catch(() => null) : null);
  if (!target) {
    await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription("❌ Usage: `!kick @user [reason]`")] });
    return;
  }
  if (!target.kickable) {
    await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription("❌ I cannot kick that member. Make sure my role is above theirs.")] });
    return;
  }
  if (target.id === message.author.id) {
    await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription("❌ You cannot kick yourself.")] });
    return;
  }
  const reason = args.slice(1).join(" ") || "No reason provided";
  const quota = await reserveModerationAction(message.guild.id, message.author.id, "kick");
  if (!quota.allowed) {
    await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription(`❌ Your kick limit has been reached (${quota.limit}). Ask a server admin to reset or raise it.`)] });
    return;
  }
  try {
    await target.send(premiumMessagePayload({
      embeds: [new EmbedBuilder().setColor(C).setTitle(`🥾 You were kicked from ${message.guild.name}`).addFields({ name: "Reason", value: reason })],
    }, message.client?.user ?? null)).catch(() => {});
    await target.kick(reason);
  } catch {
    if (quota.reserved) await releaseModerationAction(message.guild.id, message.author.id, "kick").catch(() => {});
    await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription("❌ Failed to kick that member.")] });
    return;
  }
  await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription(`✅ **${target.user.username}** has been kicked.\n**Reason:** ${reason}`)] });
}

// ─── Ban ───────────────────────────────────────────────────────────────────────

export async function handleBan(message: Message): Promise<void> {
  if (!message.guild) return;
  const mod = message.member ?? await message.guild.members.fetch(message.author.id).catch(() => null);
  if (!mod?.permissions.has(PermissionFlagsBits.BanMembers)) {
    await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription("❌ You need **Ban Members** permission.")] });
    return;
  }
  const args = message.content.trim().split(/\s+/).slice(1);
  const targetId = message.mentions.members?.first()?.id ?? args[0];
  if (!targetId) {
    await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription("❌ Usage: `!ban @user|<user_id> [reason]`")] });
    return;
  }
  if (targetId === message.author.id) {
    await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription("❌ You cannot ban yourself.")] });
    return;
  }
  const target = await message.guild.members.fetch(targetId).catch(() => null);
  const reason = args.slice(1).join(" ") || "No reason provided";
  if (!target && !/^\d{17,20}$/.test(targetId)) {
    await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription("❌ Mention a member or provide a valid Discord user ID. Usage: `!ban @user|<user_id> [reason]`")] });
    return;
  }
  if (target && !target.bannable) {
    await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription("❌ I cannot ban that member.")] });
    return;
  }
  if (!target) {
    const existingBan = await message.guild.bans.fetch(targetId).catch(() => null);
    if (existingBan) {
      await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription(`ℹ️ User \`${targetId}\` is already banned.`)] });
      return;
    }
  }
  const quota = await reserveModerationAction(message.guild.id, message.author.id, "ban");
  if (!quota.allowed) {
    await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription(`❌ Your ban limit has been reached (${quota.limit}). Ask a server admin to reset or raise it.`)] });
    return;
  }
  try {
    if (target) {
      await target.send(premiumMessagePayload({
        embeds: [new EmbedBuilder().setColor(C).setTitle(`🔨 You were banned from ${message.guild.name}`).addFields({ name: "Reason", value: reason })],
      }, message.client?.user ?? null)).catch(() => {});
      await target.ban({ reason, deleteMessageSeconds: 7 * 24 * 60 * 60 });
    } else {
      await message.guild.bans.create(targetId, { reason, deleteMessageSeconds: 7 * 24 * 60 * 60 });
    }
  } catch {
    if (quota.reserved) await releaseModerationAction(message.guild.id, message.author.id, "ban").catch(() => {});
    await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription("❌ Failed to ban that member.")] });
    return;
  }
  await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription(target
    ? `✅ **${target.user.username}** has been banned.\n**Reason:** ${reason}`
    : `✅ User ID \`${targetId}\` has been banned.\n**Reason:** ${reason}`)] });
}

// ─── Unban ─────────────────────────────────────────────────────────────────────

export async function handleUnban(message: Message): Promise<void> {
  if (!message.guild) return;
  const mod = message.guild.members.cache.get(message.author.id);
  if (!mod?.permissions.has(PermissionFlagsBits.BanMembers)) {
    await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription("❌ You need **Ban Members** permission.")] });
    return;
  }
  const args = message.content.trim().split(/\s+/).slice(1);
  const userId = args[0];
  if (!userId) {
    await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription("❌ Usage: `!unban <user_id>`")] });
    return;
  }
  try {
    const ban = await message.guild.bans.fetch(userId).catch(() => null);
    const targetTag = ban?.user.tag ?? userId;
    await message.guild.bans.remove(userId);
    await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription(`✅ User \`${targetTag}\` has been unbanned.`)] });
  } catch {
    await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription("❌ Could not unban that user. Make sure the ID is correct.")] });
  }
}

// ─── Nuke ─────────────────────────────────────────────────────────────────────

export async function handleNuke(message: Message): Promise<void> {
  if (!message.guild) return;
  const mod = message.guild.members.cache.get(message.author.id);
  if (!mod?.permissions.has(PermissionFlagsBits.ManageChannels)) {
    await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription("❌ You need **Manage Channels** permission.")] });
    return;
  }

  const channel = message.channel as TextChannel;

  const confirmMsg = await message.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(C)
        .setTitle("⚠️ Confirm Nuke")
        .setDescription("This will **delete all messages** in this channel by cloning it.\nClick **Confirm** to proceed or **Cancel** to abort."),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("nuke_confirm").setLabel("Confirm").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("nuke_cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary),
      ),
    ],
  });

  const collector = confirmMsg.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 15_000,
    filter: (i) => i.user.id === message.author.id,
    max: 1,
  });

  collector.on("collect", async (interaction) => {
    if (interaction.customId === "nuke_cancel") {
      await interaction.update({
        embeds: [premiumEmbed("❌ Nuke cancelled.", { title: "Channel reset" }, message.client?.user ?? null)],
        components: [],
      });
      return;
    }
    await interaction.deferUpdate();
    try {
      const position = channel.position;
      const newChannel = await channel.clone({ reason: `Nuke by ${message.author.tag}` });
      await newChannel.setPosition(position);
      await channel.delete();
      await newChannel.send(premiumMessagePayload({
        embeds: [new EmbedBuilder().setColor(C).setDescription("💥 Channel has been nuked.")],
      }, message.client?.user ?? null));
    } catch {
      await (message.channel as TextChannel).send(premiumMessagePayload({
        embeds: [new EmbedBuilder().setColor(C).setDescription("❌ Failed to nuke channel.")],
      }, message.client?.user ?? null)).catch(() => {});
    }
  });

  collector.on("end", async (_c, reason) => {
    if (reason === "time") {
      await confirmMsg.edit({
        embeds: [premiumEmbed("❌ Nuke timed out.", { title: "Channel reset" }, message.client?.user ?? null)],
        components: [],
      }).catch(() => {});
    }
  });
}

// ─── Slowmode ─────────────────────────────────────────────────────────────────

export async function handleSlowmode(message: Message): Promise<void> {
  if (!message.guild) return;
  const mod = message.guild.members.cache.get(message.author.id);
  if (!mod?.permissions.has(PermissionFlagsBits.ManageChannels)) {
    await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription("❌ You need **Manage Channels** permission.")] });
    return;
  }
  const args = message.content.trim().split(/\s+/).slice(1);
  const seconds = parseInt(args[0]);
  if (isNaN(seconds) || seconds < 0 || seconds > 21600) {
    await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription("❌ Usage: `!slowmode <seconds>` (0–21600)")] });
    return;
  }
  try {
    await (message.channel as TextChannel).setRateLimitPerUser(seconds);
    await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription(seconds === 0 ? "✅ Slowmode disabled." : `✅ Slowmode set to **${seconds}s**.`)] });
  } catch {
    await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription("❌ Failed to set slowmode.")] });
  }
}

// ─── Lock / Unlock ────────────────────────────────────────────────────────────

export async function handleLock(message: Message): Promise<void> {
  if (!message.guild) return;
  const mod = message.guild.members.cache.get(message.author.id);
  if (!mod?.permissions.has(PermissionFlagsBits.ManageChannels)) {
    await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription("❌ You need **Manage Channels** permission.")] });
    return;
  }
  try {
    await (message.channel as TextChannel).permissionOverwrites.edit(message.guild.id, { SendMessages: false });
    await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription("🔒 Channel locked. Members cannot send messages.")] });
  } catch {
    await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription("❌ Failed to lock channel.")] });
  }
}

export async function handleUnlock(message: Message): Promise<void> {
  if (!message.guild) return;
  const mod = message.guild.members.cache.get(message.author.id);
  if (!mod?.permissions.has(PermissionFlagsBits.ManageChannels)) {
    await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription("❌ You need **Manage Channels** permission.")] });
    return;
  }
  try {
    await (message.channel as TextChannel).permissionOverwrites.edit(message.guild.id, { SendMessages: null });
    await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription("🔓 Channel unlocked.")] });
  } catch {
    await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription("❌ Failed to unlock channel.")] });
  }
}

async function handleChannelVisibility(message: Message, hidden: boolean, args: string[]): Promise<void> {
  const guild = message.guild;
  if (!guild) return;

  const member = message.member ?? await guild.members.fetch(message.author.id).catch(() => null);
  if (!member?.permissions.has(PermissionFlagsBits.ManageChannels)) {
    await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription("❌ You need **Manage Channels** permission.")] });
    return;
  }

  const channelToken = args[0] ?? "";
  const channelId = /^<#(\d{17,20})>$/.exec(channelToken)?.[1] ?? (/^\d{17,20}$/.test(channelToken) ? channelToken : null);
  if (channelToken && !channelId && !message.mentions.channels.first()) {
    await message.reply("Usage: `!hide [#channel]` or `!unhide [#channel]`.");
    return;
  }
  const channel = channelId
    ? await guild.channels.fetch(channelId).catch(() => null)
    : message.mentions.channels.first() ?? message.channel;
  if (!channel || !("guildId" in channel) || channel.guildId !== guild.id) {
    await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription("❌ I couldn't find that channel in this server.")] });
    return;
  }

  if (!("permissionOverwrites" in channel)) {
    await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription("❌ This channel's visibility cannot be changed here.")] });
    return;
  }

  try {
    await channel.permissionOverwrites.edit(guild.roles.everyone, {
      ViewChannel: hidden ? false : null,
    });
  } catch {
    await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription("❌ Failed to change this channel's visibility.")] });
    return;
  }

  const description = hidden
    ? `🙈 <#${channel.id}> is hidden from @everyone. Staff with access can still view it.`
    : `👁️ <#${channel.id}> is visible to @everyone again.`;
  await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription(description)] })
    .catch(() => message.author.send(description).catch(() => {}));
}

export async function handleHide(message: Message, args: string[]): Promise<void> {
  await handleChannelVisibility(message, true, args);
}

export async function handleUnhide(message: Message, args: string[]): Promise<void> {
  await handleChannelVisibility(message, false, args);
}

export async function handleAutoModeration(message: Message): Promise<boolean> {
  if (!message.guild || message.author.bot || !message.content.trim()) return false;
  const guildConfig = getAutomodConfig(message.guild.id);

  const member = message.member;
  if (member?.permissions.has(PermissionFlagsBits.ManageGuild) || member?.permissions.has(PermissionFlagsBits.Administrator)) {
    return false;
  }

  const content = message.content.toLowerCase();

  if (guildConfig.invites) {
    const invitePattern = /(discord(?:app)?\.(?:gg|com\/invite|me)|discord\.gift|discord\.gg)/i;
    if (invitePattern.test(message.content)) {
      await applyAutomodAction(message, "Discord invite link detected.");
      return true;
    }
  }

  const hosts = getLinkHosts(message.content);
  if (hosts.some((host) =>
    guildConfig.blockedDomains.some((domain) => domainMatches(host, domain)),
  )) {
    await applyAutomodAction(message, "Blocked link domain detected.");
    return true;
  }

  if (
    guildConfig.links &&
    /(https?:\/\/|www\.)\S+/i.test(message.content) &&
    !message.content.includes("https://discord.com/channels")
  ) {
    const hasDisallowedLink = hosts.length === 0 || hosts.some((host) =>
      !guildConfig.allowedDomains.some((domain) => domainMatches(host, domain)),
    );
    if (hasDisallowedLink) {
      await applyAutomodAction(message, "External links are not allowed.");
      return true;
    }
  }

  if (guildConfig.mentionLimit > 0 && message.mentions.users.size > guildConfig.mentionLimit) {
    await applyAutomodAction(message, `Mention limit exceeded (${guildConfig.mentionLimit}).`);
    return true;
  }

  for (const blockedWord of guildConfig.blacklist) {
    const word = sanitizeWord(blockedWord);
    if (!word) continue;
    if (content.includes(word)) {
      await applyAutomodAction(message, `Blocked word detected: ${blockedWord}`);
      return true;
    }
  }

  return false;
}

export async function handleAutomodCommand(message: Message): Promise<void> {
  if (!message.guild) return;
  const member = message.guild.members.cache.get(message.author.id);
  if (!member?.permissions.has(PermissionFlagsBits.ManageGuild) && !member?.permissions.has(PermissionFlagsBits.Administrator)) {
    await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription("❌ You need **Manage Server** permission.")] });
    return;
  }

  const args = message.content.trim().split(/\s+/).slice(1);
  const sub = args[0]?.toLowerCase() ?? "status";
  const config = getAutomodConfig(message.guild.id);

  if (sub === "status") {
    await message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(C)
          .setTitle("Auto moderation")
          .setDescription([
            `Invites: ${config.invites ? "On" : "Off"}`,
            `Links: ${config.links ? "On" : "Off"}`,
            `Mention limit: ${config.mentionLimit}`,
            `Blocked words: ${formatAutomodList(config.blacklist)}`,
          ].join("\n"))
          .addFields(
            { name: "Blocked link domains", value: formatAutomodList(config.blockedDomains) },
            { name: "Allowed link domains", value: formatAutomodList(config.allowedDomains) },
          ),
      ],
    });
    return;
  }

  if (sub === "set") {
    const setting = args[1]?.toLowerCase();
    const value = args[2]?.toLowerCase();

    if (setting === "invites") {
      if (value !== "on" && value !== "off") {
        await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription("❌ Usage: `!automod set invites on|off`")] });
        return;
      }
      const next = { ...config, invites: value === "on" };
      persistAutomodConfig(message.guild.id, next);
      await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription(`✅ Invite filtering is now **${value.toUpperCase()}**.`)] });
      return;
    }

    if (setting === "links") {
      if (value !== "on" && value !== "off") {
        await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription("❌ Usage: `!automod set links on|off`")] });
        return;
      }
      const next = { ...config, links: value === "on", linksConfigured: true };
      persistAutomodConfig(message.guild.id, next);
      await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription(`✅ Link filtering is now **${value.toUpperCase()}**.`)] });
      return;
    }

    if (setting === "mentions") {
      const limit = Number.parseInt(value ?? "", 10);
      if (!Number.isInteger(limit) || limit < 0 || limit > 20) {
        await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription("❌ Usage: `!automod set mentions <0-20>`")] });
        return;
      }
      const next = { ...config, mentionLimit: limit };
      persistAutomodConfig(message.guild.id, next);
      await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription(`✅ Mention limit set to **${limit}**.`)] });
      return;
    }

    await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription("❌ Usage: `!automod set invites|links|mentions <value>`")] });
    return;
  }

  if (sub === "add" || sub === "block" || sub === "blacklist") {
    const word = args.slice(1).join(" ").trim();
    if (!word) {
      await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription("❌ Usage: `!automod add <word>`")] });
      return;
    }
    const clean = sanitizeWord(word);
    if (!clean) {
      await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription("❌ That word is invalid.")] });
      return;
    }
    const next = { ...config, blacklist: [...new Set([...config.blacklist, clean])].sort() };
    persistAutomodConfig(message.guild.id, next);
    await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription(`✅ Added blocked word: **${clean}**.`)] });
    return;
  }

  if (sub === "remove" || sub === "unblock") {
    const word = args.slice(1).join(" ").trim();
    if (!word) {
      await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription("❌ Usage: `!automod remove <word>`")] });
      return;
    }
    const clean = sanitizeWord(word);
    const next = { ...config, blacklist: config.blacklist.filter((entry) => entry !== clean) };
    persistAutomodConfig(message.guild.id, next);
    await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription(`✅ Removed blocked word: **${clean}**.`)] });
    return;
  }

  const domainRuleCommands: Record<string, { key: "blockedDomains" | "allowedDomains"; add: boolean }> = {
    blocklink: { key: "blockedDomains", add: true },
    blockdomain: { key: "blockedDomains", add: true },
    unblocklink: { key: "blockedDomains", add: false },
    unblockdomain: { key: "blockedDomains", add: false },
    allowlink: { key: "allowedDomains", add: true },
    allowdomain: { key: "allowedDomains", add: true },
    unallowlink: { key: "allowedDomains", add: false },
    unallowdomain: { key: "allowedDomains", add: false },
  };
  const domainRule = domainRuleCommands[sub];
  if (domainRule) {
    const rawDomain = args.slice(1).join(" ");
    const domain = sanitizeDomain(rawDomain);
    if (!domain) {
      await message.reply({
        embeds: [new EmbedBuilder().setColor(C).setDescription(
          `❌ Usage: \`!automod ${sub} <domain>\` (for example, \`example.com\`).`,
        )],
      });
      return;
    }

    const domains = config[domainRule.key];
    const nextDomains = domainRule.add
      ? [...new Set([...domains, domain])].sort()
      : domains.filter((entry) => entry !== domain);
    persistAutomodConfig(message.guild.id, { ...config, [domainRule.key]: nextDomains });
    await message.reply({
      embeds: [new EmbedBuilder().setColor(C).setDescription(
        domainRule.add
          ? `✅ ${domainRule.key === "blockedDomains" ? "Blocked" : "Allowed"} links from **${domain}** (including its subdomains).`
          : `✅ Removed **${domain}** from the ${domainRule.key === "blockedDomains" ? "blocked" : "allowed"} domain list.`,
      )],
    });
    return;
  }

  await message.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(C)
        .setDescription(
          "**Auto moderation**\n" +
          "`!automod status` — view current rules\n" +
          "`!automod set invites on|off` — block Discord invite links\n" +
          "`!automod set links on|off` — block external links\n" +
          "`!automod set mentions <0-20>` — max mentions per message\n" +
          "`!automod add <word>` — block a word\n" +
          "`!automod remove <word>` — remove a blocked word\n" +
          "`!automod blocklink <domain>` / `unblocklink <domain>` — block or unblock a domain\n" +
          "`!automod allowlink <domain>` / `unallowlink <domain>` — allow or remove a domain from the link-filter allowlist",
        ),
    ],
  });
}
