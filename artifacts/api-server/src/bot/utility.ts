import {
  AttachmentBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  type Message,
  type PartialMessage,
  type Role,
  type TextChannel,
  type Client,
} from "discord.js";
import { premiumMessagePayload } from "./presentation";
import { renderQuoteImage } from "./quoteImage";
import { requireQuoteChannel } from "./quoteChannel";

const C = 0xff0000;
const snipedMessages = new Map<string, {
  authorId: string;
  authorName: string;
  avatarUrl: string;
  content: string;
  attachmentUrl: string | null;
  deletedAt: number;
}>();

export async function rememberDeletedMessage(message: Message | PartialMessage): Promise<void> {
  if (message.partial) return;
  if (!message.guildId || message.author?.bot) return;
  const attachment = message.attachments.first();
  if (!message.content.trim() && !attachment) return;

  snipedMessages.set(message.channelId, {
    authorId: message.author.id,
    authorName: message.member?.displayName ?? message.author.displayName,
    avatarUrl: message.author.displayAvatarURL({ size: 128 }),
    content: message.content.trim().slice(0, 3000),
    attachmentUrl: attachment?.url ?? null,
    deletedAt: Date.now(),
  });
}

function parseRole(guild: NonNullable<Message["guild"]>, input: string): Role | null {
  const roleId = /^<@&(\d{17,20})>$/.exec(input)?.[1] ?? input;
  return guild.roles.cache.get(roleId) ??
    guild.roles.cache.find((role) => role.name.toLocaleLowerCase() === input.toLocaleLowerCase()) ??
    null;
}

export async function handleRoleInfo(message: Message): Promise<void> {
  const guild = message.guild;
  if (!guild) return;
  const role = message.mentions.roles.first() ?? parseRole(guild, message.content.trim().replace(/^!roleinfo\s*/i, ""));
  if (!role) {
    await message.reply({ content: "Usage: `!roleinfo @role` or `!roleinfo Role Name`", allowedMentions: { parse: [], repliedUser: false } });
    return;
  }

  const permissions = role.permissions.toArray();
  const permissionSummary = permissions.slice(0, 6).map((permission) => permission.replace(/([a-z])([A-Z])/g, "$1 $2")).join(", ") || "None";
  await message.reply({
    suppressHelpFooter: true,
    embeds: [
      new EmbedBuilder()
        .setColor(role.color || C)
        .setTitle(`🎭 ${role.name}`)
        .setDescription(
          `<@&${role.id}> · \`${role.id}\`\n` +
          `👥 ${role.members.size} members · Position ${role.position} · ${role.hoist ? "Displayed separately" : "Not hoisted"}\n` +
          `Permissions: ${permissionSummary}${permissions.length > 6 ? ` +${permissions.length - 6} more` : ""}`,
        ),
    ],
    allowedMentions: { parse: [] },
  });
}

export async function handleBanner(message: Message): Promise<void> {
  const guild = message.guild;
  if (!guild) return;
  const [, modeOrTarget, targetArgument] = message.content.trim().split(/\s+/, 3);
  const isServerBanner = modeOrTarget?.toLowerCase() === "server";

  if (isServerBanner) {
    const bannerUrl = guild.bannerURL({ size: 4096 });
    const embed = new EmbedBuilder()
      .setColor(C)
      .setTitle(`${guild.name} server banner`)
      .setDescription(bannerUrl ? `[Open banner](${bannerUrl})` : "This server has no banner set.");
    if (bannerUrl) embed.setImage(bannerUrl);
    await message.reply({
      suppressHelpFooter: true,
      embeds: [embed],
      allowedMentions: { parse: [] },
    });
    return;
  }

  const target = message.mentions.users.first() ??
    (modeOrTarget?.toLowerCase() === "user" && targetArgument
      ? guild.members.cache.get(targetArgument)?.user ?? null
      : message.author);
  if (!target) {
    await message.reply({ content: "Mention a server member. Usage: `!banner user @user`.", allowedMentions: { parse: [], repliedUser: false } });
    return;
  }

  const freshUser = await target.fetch(true).catch(() => target);
  const bannerUrl = freshUser.bannerURL({ size: 4096 });
  const embed = new EmbedBuilder()
    .setColor(C)
    .setTitle(`${freshUser.username}'s banner`)
    .setDescription(bannerUrl ? `[Open banner](${bannerUrl})` : "This user has no profile banner set.");
  if (bannerUrl) embed.setImage(bannerUrl);
  await message.reply({
    suppressHelpFooter: true,
    embeds: [embed],
    allowedMentions: { parse: [] },
  });
}

export async function handleSnipe(message: Message): Promise<void> {
  if (!message.guild) return;
  const entry = snipedMessages.get(message.channelId);
  if (!entry) {
    await message.reply({ content: "There is no deleted message to show in this channel.", allowedMentions: { parse: [], repliedUser: false } });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(C)
    .setAuthor({ name: entry.authorName, iconURL: entry.avatarUrl })
    .setDescription(entry.content || "[Attachment]")
    .setTimestamp(entry.deletedAt);
  if (entry.attachmentUrl) embed.addFields({ name: "Attachment", value: `[Open file](${entry.attachmentUrl})` });
  await message.reply({
    suppressHelpFooter: true,
    embeds: [embed],
    allowedMentions: { parse: [] },
  });
}

// ─── User Info ─────────────────────────────────────────────────────────────────

export async function handleUserInfo(message: Message): Promise<void> {
  if (!message.guild) return;
  const target =
    message.mentions.members?.first() ??
    message.guild.members.cache.get(message.content.trim().split(/\s+/)[1] ?? "") ??
    message.guild.members.cache.get(message.author.id)!;

  if (!target) {
    await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription("❌ Could not find that member.")] });
    return;
  }

  const roleCount = target.roles.cache.size - 1;
  const roleNames = target.roles.cache
    .filter((r) => r.id !== message.guild!.id)
    .sort((a, b) => b.position - a.position)
    .map((role) => role.name)
    .slice(0, 5);
  const roles = `${roleNames.join(", ") || "None"}${roleCount > roleNames.length ? ` +${roleCount - roleNames.length} more` : ""}`;

  const joinedAt = target.joinedAt ? `<t:${Math.floor(target.joinedAt.getTime() / 1000)}:R>` : "Unknown";
  const createdAt = `<t:${Math.floor(target.user.createdAt.getTime() / 1000)}:F>`;

  await message.reply({
    suppressHelpFooter: true,
    embeds: [
      new EmbedBuilder()
        .setColor(C)
        .setTitle(`👤 ${target.displayName}`)
        .setDescription(
          `<@${target.id}> · ${target.user.bot ? "Bot" : "Member"} · \`${target.id}\`\n` +
          `Joined ${joinedAt} · Created <t:${Math.floor(target.user.createdAt.getTime() / 1000)}:R>\n` +
          `Roles (${roleCount}): ${roles}`,
        ),
    ],
  });
}

// ─── Server Info ───────────────────────────────────────────────────────────────

export async function handleServerInfo(message: Message): Promise<void> {
  if (!message.guild) return;
  const guild = message.guild;
  await guild.members.fetch().catch(() => {});

  const owner = await guild.fetchOwner().catch(() => null);
  const createdAt = `<t:${Math.floor(guild.createdAt.getTime() / 1000)}:F>`;
  const humans = guild.members.cache.filter((m) => !m.user.bot).size;
  const bots = guild.members.cache.filter((m) => m.user.bot).size;

  await message.reply({
    suppressHelpFooter: true,
    embeds: [
      new EmbedBuilder()
        .setColor(C)
        .setTitle("🏠 Server Info")
        .setDescription(
          `**${guild.name}** · \`${guild.id}\`\n` +
          `👑 ${owner ? `<@${owner.id}>` : "Unknown"} · Created <t:${Math.floor(guild.createdAt.getTime() / 1000)}:R>\n` +
          `👥 ${guild.memberCount} · 👤 ${humans} humans · 🤖 ${bots} bots\n` +
          `#️⃣ ${guild.channels.cache.size} channels · 🛡️ ${guild.roles.cache.size} roles · 🚀 Boost ${guild.premiumTier}`,
        ),
    ],
  });
}

// ─── Member Count ───────────────────────────────────────────────────────────────

export async function handleMemberCount(message: Message): Promise<void> {
  if (!message.guild) return;
  const guild = message.guild;

  await guild.members.fetch({ withPresences: true }).catch(() => {});

  let online = 0;
  let idle = 0;
  let dnd = 0;
  let offline = 0;
  let humans = 0;
  let bots = 0;

  for (const member of guild.members.cache.values()) {
    if (member.user.bot) bots++;
    else humans++;

    switch (member.presence?.status) {
      case "online":
        online++;
        break;
      case "idle":
        idle++;
        break;
      case "dnd":
        dnd++;
        break;
      default:
        offline++;
    }
  }

  const active = online + idle + dnd;
  await message.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("📊 Members")
        .setDescription(
          `👥 **${guild.memberCount}** · 👤 ${humans} humans · 🤖 ${bots} bots\n` +
          `🟢 ${online} online · 🟡 ${idle} idle · 🔴 ${dnd} DND · ⚫ ${offline} offline\n` +
          `✨ ${active} active`,
        ),
    ],
  });
}

// ─── Bot Info ───────────────────────────────────────────────────────────────────

function formatDuration(milliseconds: number): string {
  let seconds = Math.floor(milliseconds / 1000);
  const days = Math.floor(seconds / 86400);
  seconds %= 86400;
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;

  return [
    days > 0 ? `${days}d` : "",
    hours > 0 ? `${hours}h` : "",
    minutes > 0 ? `${minutes}m` : "",
    `${seconds}s`,
  ].filter(Boolean).join(" ");
}

export async function handlePing(client: Client, message: Message): Promise<void> {
  await message.reply({
    suppressHelpFooter: true,
    embeds: [
      new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle("🏓 Pong!")
        .setDescription(`WebSocket **${client.ws.ping} ms** · Uptime **${formatDuration(client.uptime ?? 0)}**`),
    ],
  });
}

export async function handleBotInfo(client: Client, message: Message): Promise<void> {
  const user = client.user;
  await message.reply({
    suppressHelpFooter: true,
    embeds: [
      new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("🤖 Bot Info")
        .setDescription(
          `${user ? `${user} · \`${user.tag}\`` : "Unknown"}\n` +
          `🌐 ${client.guilds.cache.size} servers · ⏱️ ${formatDuration(client.uptime ?? 0)} · 🛰️ ${client.ws.ping} ms`,
        ),
    ],
  });
}

export async function handleChannelInfo(message: Message): Promise<void> {
  if (!message.guild) return;
  const channel = message.channel as TextChannel;
  await message.reply({
    suppressHelpFooter: true,
    embeds: [
      new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`📺 #${channel.name}`)
        .setDescription(
          `\`${channel.id}\` · Type ${String(channel.type)}\n` +
          `Category ${channel.parent ? `<#${channel.parent.id}>` : "None"} · Created ${channel.createdAt ? `<t:${Math.floor(channel.createdAt.getTime() / 1000)}:R>` : "Unknown"}`,
        ),
    ],
  });
}

// ─── Avatar ────────────────────────────────────────────────────────────────────

export async function handleAvatar(message: Message): Promise<void> {
  const target =
    message.mentions.users.first() ??
    (message.guild?.members.cache.get(message.content.trim().split(/\s+/)[1] ?? "")?.user) ??
    message.author;

  const avatarUrl = target.displayAvatarURL({ size: 1024 });

  await message.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(C)
        .setTitle(`🖼️ ${target.username}'s Avatar`)
        .setImage(avatarUrl)
        .setDescription(`[Open in browser](${avatarUrl})`),
    ],
  });
}

export async function handleQuote(message: Message): Promise<void> {
  if (!message.guild || !(await requireQuoteChannel(message))) return;
  const quote = message.content.trim().replace(/^!quote\s*/i, "").replace(/^(["'“])([\s\S]*)["'”]$/, "$2").trim();
  if (!quote) {
    await message.reply("Usage: `!quote <text>` or `/quote <text>`.");
    return;
  }

  try {
    const image = await renderQuoteImage(
      message.author.displayAvatarURL({ extension: "png", size: 256 }),
      message.member?.displayName ?? message.author.displayName,
      message.author.username,
      quote,
    );
    const attachment = new AttachmentBuilder(image, { name: "quote.png" });
    await message.reply({
      suppressHelpFooter: true,
      embeds: [
        new EmbedBuilder()
          .setColor(0x000000)
          .setDescription(`“${quote.slice(0, 4000)}”`)
          .setImage("attachment://quote.png"),
      ],
      files: [attachment],
      allowedMentions: { parse: [], repliedUser: false },
    });
  } catch {
    await message.reply("❌ Could not create the quote image. Please try again.");
  }
}

// ─── Role ──────────────────────────────────────────────────────────────────────

export async function handleRole(message: Message): Promise<void> {
  if (!message.guild) return;
  const mod = message.guild.members.cache.get(message.author.id);
  if (!mod?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription("❌ You need **Manage Roles** permission.")] });
    return;
  }

  const target = message.mentions.members?.first();
  let role = message.mentions.roles.first();
  if (!role) {
    const roleName = message.content.trim().split(/\s+/).slice(2).join(" ").replace(/^['"]|['"]$/g, "").trim();
    const matches = message.guild.roles.cache.filter(
      (candidate) => candidate.name.toLocaleLowerCase() === roleName.toLocaleLowerCase(),
    );
    if (matches.size === 1) role = matches.first() ?? null;
    else if (matches.size > 1) {
      await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription("❌ Multiple roles have that name. Please mention the role instead.")] });
      return;
    }
  }

  if (!target || !role) {
    await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription("❌ Usage: `!role @user @role` or `!role @user Role Name`")] });
    return;
  }

  if (role.position >= mod.roles.highest.position) {
    await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription("❌ You cannot manage a role higher than or equal to your own.")] });
    return;
  }

  try {
    if (target.roles.cache.has(role.id)) {
      await target.roles.remove(role);
      await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription(`✅ Removed role <@&${role.id}> from **${target.displayName}**.`)] });
    } else {
      await target.roles.add(role);
      await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription(`✅ Added role <@&${role.id}> to **${target.displayName}**.`)] });
    }
  } catch {
    await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription("❌ Failed to manage that role. Check my permissions and role hierarchy.")] });
  }
}

// ─── Nickname ──────────────────────────────────────────────────────────────────

export async function handleNick(message: Message): Promise<void> {
  if (!message.guild) return;
  const mod = message.guild.members.cache.get(message.author.id);
  if (!mod?.permissions.has(PermissionFlagsBits.ManageNicknames)) {
    await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription("❌ You need **Manage Nicknames** permission.")] });
    return;
  }

  const args = message.content.trim().split(/\s+/).slice(1);
  const target = message.mentions.members?.first();

  if (!target) {
    await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription("❌ Usage: `!nick @user <new nickname>` or `!nick @user reset`")] });
    return;
  }

  const nick = args.slice(1).join(" ");
  const newNick = nick.toLowerCase() === "reset" ? null : nick || null;

  try {
    await target.setNickname(newNick);
    await message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(C)
          .setDescription(
            newNick
              ? `✅ Changed **${target.user.username}**'s nickname to **${newNick}**.`
              : `✅ Reset **${target.user.username}**'s nickname.`
          ),
      ],
    });
  } catch {
    await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription("❌ Failed to change nickname. Check my role hierarchy.")] });
  }
}

// ─── Announce ──────────────────────────────────────────────────────────────────

export async function handleAnnounce(message: Message): Promise<void> {
  if (!message.guild) return;
  const mod = message.guild.members.cache.get(message.author.id);
  if (!mod?.permissions.has(PermissionFlagsBits.ManageGuild)) {
    await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription("❌ You need **Manage Server** permission.")] });
    return;
  }

  const args = message.content.trim().split(/\s+/).slice(1);
  const targetChannel = message.mentions.channels.first() as TextChannel | undefined;

  if (!targetChannel || args.length < 2) {
    await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription("❌ Usage: `!announce #channel <message>`")] });
    return;
  }

  const text = args.slice(1).join(" ");
  if (!text) {
    await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription("❌ Please provide a message to announce.")] });
    return;
  }

  await targetChannel.send(premiumMessagePayload({
    embeds: [
      new EmbedBuilder()
        .setColor(C)
        .setDescription(text)
        .setFooter({ text: `Announced by ${message.author.username}` })
        .setTimestamp(),
    ],
  }, message.client?.user ?? null));

  await message.reply({ embeds: [new EmbedBuilder().setColor(C).setDescription(`✅ Announcement sent to ${targetChannel}.`)] });
}
