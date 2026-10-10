import {
  EmbedBuilder,
  PermissionFlagsBits,
  type Message,
  type TextChannel,
  type Client,
} from "discord.js";
import { premiumMessagePayload } from "./presentation";

const C = 0xff0000;

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

  const roles = target.roles.cache
    .filter((r) => r.id !== message.guild!.id)
    .sort((a, b) => b.position - a.position)
    .map((r) => `<@&${r.id}>`)
    .slice(0, 10)
    .join(", ") || "None";

  const joinedAt = target.joinedAt ? `<t:${Math.floor(target.joinedAt.getTime() / 1000)}:F>` : "Unknown";
  const createdAt = `<t:${Math.floor(target.user.createdAt.getTime() / 1000)}:F>`;

  await message.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(C)
        .setTitle(`👤 ${target.user.username}`)
        .setThumbnail(target.user.displayAvatarURL({ size: 256 }))
        .addFields(
          { name: "Display Name", value: target.displayName, inline: true },
          { name: "ID", value: target.id, inline: true },
          { name: "Bot", value: target.user.bot ? "Yes" : "No", inline: true },
          { name: "Account Created", value: createdAt, inline: false },
          { name: "Joined Server", value: joinedAt, inline: false },
          { name: `Roles (${target.roles.cache.size - 1})`, value: roles, inline: false },
        )
        .setFooter({ text: `Requested by ${message.author.username}` })
        .setTimestamp(),
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
    embeds: [
      new EmbedBuilder()
        .setColor(C)
        .setTitle(`🏠 ${guild.name}`)
        .setThumbnail(guild.iconURL({ size: 256 }) ?? null)
        .addFields(
          { name: "Owner", value: owner ? `<@${owner.id}>` : "Unknown", inline: true },
          { name: "Server ID", value: guild.id, inline: true },
          { name: "Created", value: createdAt, inline: false },
          { name: "Members", value: `👥 **${guild.memberCount}** total | 👤 ${humans} humans | 🤖 ${bots} bots`, inline: false },
          { name: "Channels", value: `${guild.channels.cache.size}`, inline: true },
          { name: "Roles", value: `${guild.roles.cache.size}`, inline: true },
          { name: "Boost Level", value: `Level ${guild.premiumTier}`, inline: true },
        )
        .setFooter({ text: `Requested by ${message.author.username}` })
        .setTimestamp(),
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
        .setTitle(`📊 Member Count — ${guild.name}`)
        .setThumbnail(guild.iconURL({ size: 256 }) ?? null)
        .addFields(
          { name: "Total Members", value: `**${guild.memberCount}**`, inline: true },
          { name: "Humans", value: `👤 **${humans}**`, inline: true },
          { name: "Bots", value: `🤖 **${bots}**`, inline: true },
          { name: "Online", value: `🟢 **${online}**`, inline: true },
          { name: "Idle", value: `🟡 **${idle}**`, inline: true },
          { name: "Do Not Disturb", value: `🔴 **${dnd}**`, inline: true },
          { name: "Offline", value: `⚫ **${offline}**`, inline: true },
          { name: "Active Now", value: `✨ **${active}**`, inline: true },
        )
        .setFooter({ text: "Presence counts require the Server Members and Presence intents." })
        .setTimestamp(),
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
    embeds: [
      new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle("🏓 Pong!")
        .addFields(
          { name: "WebSocket", value: `${client.ws.ping}ms`, inline: true },
          { name: "Uptime", value: formatDuration(client.uptime ?? 0), inline: true },
        )
        .setTimestamp(),
    ],
  });
}

export async function handleBotInfo(client: Client, message: Message): Promise<void> {
  const user = client.user;
  await message.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("🤖 Bot Information")
        .setThumbnail(user?.displayAvatarURL({ size: 256 }) ?? null)
        .addFields(
          { name: "Bot", value: user ? `${user} \`${user.tag}\`` : "Unknown", inline: false },
          { name: "Servers", value: `${client.guilds.cache.size}`, inline: true },
          { name: "Uptime", value: formatDuration(client.uptime ?? 0), inline: true },
          { name: "WebSocket", value: `${client.ws.ping}ms`, inline: true },
        )
        .setFooter({ text: "Use /help to see all commands" })
        .setTimestamp(),
    ],
  });
}

export async function handleChannelInfo(message: Message): Promise<void> {
  if (!message.guild) return;
  const channel = message.channel as TextChannel;
  await message.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`📺 Channel Information — #${channel.name}`)
        .addFields(
          { name: "Channel ID", value: channel.id, inline: true },
          { name: "Type", value: String(channel.type), inline: true },
          { name: "Category", value: channel.parent ? `<#${channel.parent.id}>` : "None", inline: true },
          { name: "Created", value: channel.createdAt ? `<t:${Math.floor(channel.createdAt.getTime() / 1000)}:F>` : "Unknown", inline: false },
        )
        .setTimestamp(),
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
