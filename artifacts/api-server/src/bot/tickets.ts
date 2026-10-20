import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  type ButtonInteraction,
  type Guild,
  type Message,
} from "discord.js";
import { and, eq } from "drizzle-orm";
import { db, botTicketSettingsTable, botTicketsTable } from "@workspace/db";
import { logger } from "../lib/logger";

function formatTicketName(userName: string): string {
  const sanitized = userName.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return `ticket-${sanitized || "user"}`.slice(0, 80);
}

function hasManageGuildPermission(member: any): boolean {
  return !!(member && typeof member.permissions?.has === "function" && member.permissions.has(PermissionFlagsBits.ManageGuild));
}

function parseTicketCategory(guild: Guild, raw: string | undefined): string | null {
  if (!raw) return null;
  const match = /^<#?(\d{17,20})>?$/.exec(raw) ?? /^(\d{17,20})$/.exec(raw);
  const id = match?.[1];
  if (!id) return null;
  const channel = guild.channels.cache.get(id);
  if (!channel || channel.type !== ChannelType.GuildCategory) return null;
  return channel.id;
}

export async function handleTicketCommand(message: Message, args: string[]): Promise<void> {
  if (!message.guild) return;

  const member = message.member ?? await message.guild.members.fetch(message.author.id).catch(() => null);
  const sub = args[0]?.toLowerCase() ?? "help";

  if (sub === "setup" || sub === "set" || sub === "config") {
    if (!hasManageGuildPermission(member)) {
      await message.reply({
        embeds: [new EmbedBuilder().setColor(0x5865f2).setDescription("❌ You need **Manage Server** permission to configure tickets.")],
      });
      return;
    }

    const categoryId = parseTicketCategory(message.guild, args[1]);
    if (!categoryId) {
      await message.reply({
        embeds: [new EmbedBuilder().setColor(0x5865f2).setDescription("❌ Usage: `!ticket setup #category`")],
      });
      return;
    }

    await db
      .insert(botTicketSettingsTable)
      .values({ guildId: message.guild.id, categoryId })
      .onConflictDoUpdate({
        target: botTicketSettingsTable.guildId,
        set: { categoryId, updatedAt: new Date() },
      });
    await message.reply({
      embeds: [new EmbedBuilder().setColor(0x5865f2).setDescription(`✅ Ticket category set to <#${categoryId}>.`)],
    });
    return;
  }

  if (sub === "status") {
    const [settings] = await db
      .select({ categoryId: botTicketSettingsTable.categoryId })
      .from(botTicketSettingsTable)
      .where(eq(botTicketSettingsTable.guildId, message.guild.id))
      .limit(1);
    const categoryId = settings?.categoryId;
    await message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x5865f2)
          .setDescription(categoryId ? `📁 Ticket category: <#${categoryId}>` : "📁 Ticket category: not configured. Use `!ticket setup #category`"),
      ],
    });
    return;
  }

  if (sub === "close") {
    const channel = message.channel;
    if (!channel.isTextBased() || !("guildId" in channel) || channel.guildId !== message.guild.id) {
      await message.reply({
        embeds: [new EmbedBuilder().setColor(0x5865f2).setDescription("❌ Tickets can only be closed from their server text channel.")],
      });
      return;
    }
    const [ticket] = await db
      .select({ ownerId: botTicketsTable.ownerId })
      .from(botTicketsTable)
      .where(and(eq(botTicketsTable.channelId, channel.id), eq(botTicketsTable.guildId, message.guild.id)))
      .limit(1);
    const ownerId = ticket?.ownerId;
    const canClose = ownerId === message.author.id || hasManageGuildPermission(member);

    if (!ownerId || !canClose) {
      await message.reply({
        embeds: [new EmbedBuilder().setColor(0x5865f2).setDescription("❌ This is not a ticket channel, or you do not own it.")],
      });
      return;
    }

    const reason = args.slice(1).join(" ") || "No reason provided";
    const owner = ownerId ? `<@${ownerId}>` : "the ticket owner";

    await message.reply({
      embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle("Ticket closing").setDescription(`Closing this ticket for ${owner}.\nReason: **${reason}**`) ],
    });

    try {
      await channel.delete("Ticket closed by user");
    } catch (err) {
      logger.error({ err, guildId: message.guild.id, channelId: channel.id }, "Could not delete closed ticket channel");
      await message.reply("❌ The ticket could not be closed; it is still open.").catch(() => {});
      return;
    }

    await db.delete(botTicketsTable).where(eq(botTicketsTable.channelId, channel.id)).catch((err) => {
      logger.error({ err, guildId: message.guild!.id, channelId: channel.id }, "Could not remove closed ticket record");
    });

    try {
      const user = await message.guild.members.fetch(ownerId ?? message.author.id).catch(() => null);
      if (user) {
        await user.send({
          embeds: [new EmbedBuilder().setColor(0x2b2d31).setTitle("Ticket closed").setDescription(`Your ticket in **${message.guild.name}** was closed.\nReason: **${reason}**`)],
        }).catch(() => {});
      }
    } catch {
      // ignore DM errors
    }
    return;
  }

  if (sub === "new" || sub === "open") {
    const channelWithParent = message.channel && "parentId" in message.channel ? message.channel : null;
    const [settings] = await db
      .select({ categoryId: botTicketSettingsTable.categoryId })
      .from(botTicketSettingsTable)
      .where(eq(botTicketSettingsTable.guildId, message.guild.id))
      .limit(1);
    const categoryId = settings?.categoryId ?? (channelWithParent?.parentId ?? null);
    if (!categoryId) {
      await message.reply({
        embeds: [new EmbedBuilder().setColor(0x5865f2).setDescription("❌ No ticket category is configured. Use `!ticket setup #category` first.")],
      });
      return;
    }

    const category = message.guild.channels.cache.get(categoryId);
    if (!category || category.type !== ChannelType.GuildCategory) {
      await message.reply({
        embeds: [new EmbedBuilder().setColor(0x5865f2).setDescription("❌ The configured ticket category no longer exists. Use `!ticket setup #category`.")],
      });
      return;
    }

    const botMember = await message.guild.members.fetchMe().catch(() => null);
    if (!botMember?.permissions.has(PermissionFlagsBits.ManageChannels)) {
      await message.reply("❌ I need **Manage Channels** permission to open private tickets.");
      return;
    }

    const ticketName = formatTicketName(`${message.author.username}-${Date.now().toString().slice(-4)}`);
    const created = await message.guild.channels.create({
      name: ticketName,
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: [
        {
          id: message.guild.roles.everyone.id,
          deny: [PermissionFlagsBits.ViewChannel],
        },
        {
          id: message.author.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AddReactions,
          ],
        },
        {
          id: botMember.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        },
      ],
    });

    for (const role of message.guild.roles.cache.values()) {
      const permissions = (role as any).permissions;
      if (
        permissions && typeof permissions.has === "function" &&
        (permissions.has(PermissionFlagsBits.ManageGuild) || permissions.has(PermissionFlagsBits.Administrator))
      ) {
        await created.permissionOverwrites.edit(role.id, {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
          AddReactions: true,
        }).catch(() => {});
      }
    }

    try {
      await db.insert(botTicketsTable).values({
        channelId: created.id,
        guildId: message.guild.id,
        ownerId: message.author.id,
      });
    } catch (err) {
      logger.error({ err, guildId: message.guild.id, channelId: created.id }, "Could not persist ticket owner");
      await created.delete("Join ticket setup failed").catch(() => {});
      await message.reply("❌ Ticket storage is unavailable; the ticket was not opened.");
      return;
    }

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`ticket:close:${created.id}`).setLabel("Close Ticket").setStyle(ButtonStyle.Danger),
    );

    try {
      await created.send({
        embeds: [
          new EmbedBuilder()
            .setColor(0x2b2d31)
            .setTitle("🎫 Support ticket")
            .setDescription(`Hi <@${message.author.id}>, your ticket has been created.\nPlease describe your issue and a staff member will assist you.`)
            .addFields(
              { name: "Opened by", value: `<@${message.author.id}>`, inline: true },
              { name: "Status", value: "Open", inline: true },
            ),
        ],
        components: [row],
      });
    } catch (err) {
      logger.error({ err, guildId: message.guild.id, channelId: created.id }, "Could not send ticket welcome message");
      await db.delete(botTicketsTable).where(eq(botTicketsTable.channelId, created.id)).catch(() => {});
      await created.delete("Ticket setup failed").catch(() => {});
      await message.reply("❌ I couldn't send the ticket welcome message. Check my channel permissions and try again.");
      return;
    }

    await message.reply({
      embeds: [new EmbedBuilder().setColor(0x5865f2).setDescription(`✅ Ticket created: <#${created.id}>`)],
    });
    return;
  }

  await message.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x5865f2)
        .setDescription(
          "**Ticket system**\n" +
          "`!ticket new` — create a new support ticket\n" +
          "`!ticket close [reason]` — close an open ticket\n" +
          "`!ticket setup #category` — set where new tickets are created\n" +
          "`!ticket status` — check the configured category",
        ),
    ],
  });
}

export async function handleTicketInteraction(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.isButton() || !interaction.customId.startsWith("ticket:close:")) return;

  const channelId = interaction.customId.replace("ticket:close:", "");
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: "This ticket can only be closed inside a server.", ephemeral: true });
    return;
  }
  const channel = guild.channels.cache.get(channelId);
  if (!channel || !channel.isTextBased()) {
    await interaction.reply({ content: "This ticket no longer exists.", ephemeral: true });
    return;
  }
  const [ticket] = await db
    .select({ ownerId: botTicketsTable.ownerId })
    .from(botTicketsTable)
    .where(and(eq(botTicketsTable.channelId, channel.id), eq(botTicketsTable.guildId, guild.id)))
    .limit(1);
  const ownerId = ticket?.ownerId;
  if (!ownerId) {
    await interaction.reply({ content: "This ticket no longer exists.", ephemeral: true });
    return;
  }
  const permissions = interaction.memberPermissions;
  const canClose = !!(
    interaction.user.id === ownerId ||
    permissions?.has(PermissionFlagsBits.ManageGuild)
  );

  if (!canClose) {
    await interaction.reply({ content: "You cannot close this ticket.", ephemeral: true });
    return;
  }

  await interaction.update({ content: "Closing ticket...", components: [] }).catch(() => {});

  try {
    await channel.delete("Ticket closed by button");
  } catch (err) {
    logger.error({ err, guildId: guild.id, channelId: channel.id }, "Could not delete ticket channel from close button");
    await interaction.followUp({ content: "The ticket could not be closed; it is still open.", ephemeral: true }).catch(() => {});
    return;
  }

  await db.delete(botTicketsTable).where(eq(botTicketsTable.channelId, channel.id)).catch((err) => {
    logger.error({ err, guildId: guild.id, channelId: channel.id }, "Could not remove closed ticket record");
  });

  try {
    const user = ownerId ? await guild.members.fetch(ownerId).catch(() => null) : null;
    if (user) {
      await user.send({
        embeds: [new EmbedBuilder().setColor(0x2b2d31).setTitle("Ticket closed").setDescription(`Your ticket in **${guild.name}** was closed by staff.`)],
      }).catch(() => {});
    }
  } catch {
    // ignore DM errors
  }
}
