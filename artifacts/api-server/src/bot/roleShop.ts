import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  PermissionFlagsBits,
  type GuildMember,
  type Message,
  type Role,
} from "discord.js";
import { and, asc, eq } from "drizzle-orm";
import { db, botMiningProfilesTable, botRoleShopTable } from "@workspace/db";
import { logger } from "../lib/logger";

const EMBED_COLOR = 0x2b2d31;
const MAX_ROLE_PRICE = 2_147_483_647;
const ROLES_PER_PAGE = 10;

function replyEmbed(title: string, description: string): { embeds: EmbedBuilder[] } {
  return { embeds: [new EmbedBuilder().setColor(EMBED_COLOR).setTitle(title).setDescription(description)] };
}

export async function handleCreditCommand(message: Message): Promise<void> {
  const guild = message.guild;
  if (!guild) return;

  try {
    const [profile] = await db
      .select({ credits: botMiningProfilesTable.coins })
      .from(botMiningProfilesTable)
      .where(and(
        eq(botMiningProfilesTable.guildId, guild.id),
        eq(botMiningProfilesTable.userId, message.author.id),
      ))
      .limit(1);
    const credits = profile?.credits ?? 0;
    await message.reply({
      content: `<@${message.author.id}> | <:16:1553581538074038372> You have **${credits.toLocaleString()} credits**`,
      suppressHelpFooter: true,
      allowedMentions: { users: [] },
    });
  } catch (error) {
    logger.error({ err: error, guildId: guild.id, userId: message.author.id }, "Could not load user credits");
    await message.reply(replyEmbed("Credits unavailable", "I couldn't load your credit balance. Please try again."));
  }
}

function parseRoleId(value: string | undefined): string | null {
  if (!value) return null;
  return /^<@&(\d{17,20})>$/.exec(value)?.[1] ?? (/^\d{17,20}$/.test(value) ? value : null);
}

async function canAssignRole(member: GuildMember, role: Role): Promise<boolean> {
  if (role.id === member.guild.id || role.managed) return false;
  const botMember = await member.guild.members.fetchMe().catch(() => null);
  if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) return false;
  if (botMember.roles.highest.comparePositionTo(role) <= 0) return false;
  if (!member.permissions.has(PermissionFlagsBits.Administrator) && member.roles.highest.comparePositionTo(role) <= 0) return false;
  return true;
}

async function refundCredits(guildId: string, userId: string, amount: number): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(botMiningProfilesTable).values({ guildId, userId }).onConflictDoNothing();
    const [profile] = await tx.select().from(botMiningProfilesTable)
      .where(and(eq(botMiningProfilesTable.guildId, guildId), eq(botMiningProfilesTable.userId, userId)))
      .for("update");
    if (!profile) throw new Error("Could not load player profile for shop refund");
    await tx.update(botMiningProfilesTable).set({
      coins: profile.coins + amount,
      updatedAt: new Date(),
    }).where(and(eq(botMiningProfilesTable.guildId, guildId), eq(botMiningProfilesTable.userId, userId)));
  });
}

export async function handleRoleShopCommand(message: Message, args: string[]): Promise<void> {
  const guild = message.guild;
  if (!guild) return;

  const subcommand = args[0]?.toLowerCase() ?? "list";
  const member = message.member ?? await guild.members.fetch(message.author.id).catch(() => null);
  if (!member) return;

  try {
    if (subcommand === "add" || subcommand === "set") {
      if (!member.permissions.has(PermissionFlagsBits.ManageGuild) && !member.permissions.has(PermissionFlagsBits.Administrator)) {
        await message.reply(replyEmbed("Role shop", "You need **Manage Server** permission to configure the shop."));
        return;
      }

      const roleId = message.mentions.roles.first()?.id ?? parseRoleId(args[1]);
      const role = roleId ? await guild.roles.fetch(roleId).catch(() => null) : null;
      const price = /^\d+$/.test(args[2] ?? "") ? Number.parseInt(args[2]!, 10) : 0;
      if (!role || !Number.isSafeInteger(price) || price < 1 || price > MAX_ROLE_PRICE) {
        await message.reply("Usage: `!shop add @role <price in credits>` (example: `!shop add @VIP 50000`).");
        return;
      }
      if (!(await canAssignRole(member, role))) {
        await message.reply(replyEmbed("Role shop", "I or you cannot manage that role. Check Manage Roles permission and role hierarchy."));
        return;
      }

      await db.insert(botRoleShopTable)
        .values({ guildId: guild.id, roleId: role.id, price, configuredBy: message.author.id })
        .onConflictDoUpdate({
          target: [botRoleShopTable.guildId, botRoleShopTable.roleId],
          set: { price, configuredBy: message.author.id, updatedAt: new Date() },
        });
      await message.reply(replyEmbed("Role added", `${role} is now available in the shop for **${price.toLocaleString()} credits**.`));
      return;
    }

    if (subcommand === "edit" || subcommand === "price") {
      if (!member.permissions.has(PermissionFlagsBits.ManageGuild) && !member.permissions.has(PermissionFlagsBits.Administrator)) {
        await message.reply(replyEmbed("Role shop", "You need **Manage Server** permission to edit shop prices."));
        return;
      }

      const roleId = message.mentions.roles.first()?.id ?? parseRoleId(args[1]);
      const role = roleId ? await guild.roles.fetch(roleId).catch(() => null) : null;
      const price = /^\d+$/.test(args[2] ?? "") ? Number.parseInt(args[2]!, 10) : 0;
      if (!role || !Number.isSafeInteger(price) || price < 1 || price > MAX_ROLE_PRICE) {
        await message.reply("Usage: `!shop edit @role <new-price>` (example: `!shop edit @VIP 75000`).");
        return;
      }
      if (!(await canAssignRole(member, role))) {
        await message.reply(replyEmbed("Role shop", "I or you cannot manage that role. Check Manage Roles permission and role hierarchy."));
        return;
      }

      const updated = await db.update(botRoleShopTable)
        .set({ price, configuredBy: message.author.id, updatedAt: new Date() })
        .where(and(eq(botRoleShopTable.guildId, guild.id), eq(botRoleShopTable.roleId, role.id)))
        .returning({ roleId: botRoleShopTable.roleId });
      if (updated.length === 0) {
        await message.reply(replyEmbed("Role shop", `${role} isn't listed yet. Add it with \`!shop add @role <price>\`.`));
        return;
      }
      await message.reply(replyEmbed("Role price updated", `${role} now costs **${price.toLocaleString()} credits**.`));
      return;
    }

    if (subcommand === "remove" || subcommand === "delete") {
      if (!member.permissions.has(PermissionFlagsBits.ManageGuild) && !member.permissions.has(PermissionFlagsBits.Administrator)) {
        await message.reply(replyEmbed("Role shop", "You need **Manage Server** permission to configure the shop."));
        return;
      }
      const roleId = message.mentions.roles.first()?.id ?? parseRoleId(args[1]);
      if (!roleId) {
        await message.reply("Usage: `!shop remove @role`.");
        return;
      }
      const removed = await db.delete(botRoleShopTable)
        .where(and(eq(botRoleShopTable.guildId, guild.id), eq(botRoleShopTable.roleId, roleId)))
        .returning({ roleId: botRoleShopTable.roleId });
      await message.reply(removed.length
        ? replyEmbed("Role removed", `Removed <@&${roleId}> from the role shop. Existing holders keep their role.`)
        : replyEmbed("Role shop", "That role is not listed in the shop."));
      return;
    }

    if (subcommand === "buy") {
      const roleId = message.mentions.roles.first()?.id ?? parseRoleId(args[1]);
      const role = roleId ? await guild.roles.fetch(roleId).catch(() => null) : null;
      if (!role) {
        await message.reply("Usage: `!shop buy @role`.");
        return;
      }
      if (member.roles.cache.has(role.id)) {
        await message.reply(replyEmbed("Role shop", `You already have ${role}.`));
        return;
      }
      if (!(await canAssignRole(member, role))) {
        await message.reply(replyEmbed("Role shop", "That role cannot be assigned. Please contact a server administrator."));
        return;
      }

      const purchase = await db.transaction(async (tx) => {
        const [listing] = await tx.select().from(botRoleShopTable)
          .where(and(eq(botRoleShopTable.guildId, guild.id), eq(botRoleShopTable.roleId, role.id)))
          .limit(1);
        if (!listing) return { status: "unlisted" as const };

        await tx.insert(botMiningProfilesTable).values({ guildId: guild.id, userId: member.id }).onConflictDoNothing();
        const [profile] = await tx.select().from(botMiningProfilesTable)
          .where(and(eq(botMiningProfilesTable.guildId, guild.id), eq(botMiningProfilesTable.userId, member.id)))
          .for("update");
        if (!profile) throw new Error("Could not load player economy profile");
        if (profile.coins < listing.price) return { status: "funds" as const, price: listing.price, balance: profile.coins };

        await tx.update(botMiningProfilesTable).set({
          coins: profile.coins - listing.price,
          updatedAt: new Date(),
        }).where(and(eq(botMiningProfilesTable.guildId, guild.id), eq(botMiningProfilesTable.userId, member.id)));
        return { status: "charged" as const, price: listing.price, balance: profile.coins - listing.price };
      });

      if (purchase.status === "unlisted") {
        await message.reply(replyEmbed("Role shop", "That role is not currently for sale."));
        return;
      }
      if (purchase.status === "funds") {
        await message.reply(replyEmbed("Insufficient credits", `This role costs **${purchase.price.toLocaleString()} credits**. Your balance is **${purchase.balance.toLocaleString()} credits**.`));
        return;
      }

      try {
        await member.roles.add(role, "Purchased from the server role shop");
      } catch (err) {
        logger.error({ err, guildId: guild.id, userId: member.id, roleId: role.id }, "Could not assign shop role; refunding purchase");
        const refreshed = await guild.members.fetch({ user: member.id, force: true }).catch(() => null);
        if (!refreshed?.roles.cache.has(role.id)) {
          await refundCredits(guild.id, member.id, purchase.price).catch((refundErr) => {
            logger.error({ err: refundErr, guildId: guild.id, userId: member.id, roleId: role.id }, "Could not refund failed role purchase");
          });
        }
        await message.reply(replyEmbed("Purchase failed", "I couldn't assign that role. If the purchase was not applied, your credits were refunded."));
        return;
      }

      await message.reply(replyEmbed("Role purchased", `You bought ${role} for **${purchase.price.toLocaleString()} credits**.\nRemaining balance: **${purchase.balance.toLocaleString()} credits**.`));
      return;
    }

    if (subcommand === "list" || subcommand === "status") {
      const listings = await db.select().from(botRoleShopTable)
        .where(eq(botRoleShopTable.guildId, guild.id))
        .orderBy(asc(botRoleShopTable.price));
      const roles = await Promise.all(listings.map(async (listing) => ({
        listing,
        role: guild.roles.cache.get(listing.roleId) ?? await guild.roles.fetch(listing.roleId).catch(() => null),
      })));
      if (roles.length === 0) {
        await message.reply(replyEmbed("Server role shop", "No roles are listed yet. An admin can add one with `!shop add @role <price>`."));
        return;
      }

      const pageCount = Math.ceil(roles.length / ROLES_PER_PAGE);
      let currentPage = 0;
      const buildPage = (page: number) => {
        const start = page * ROLES_PER_PAGE;
        const lines = roles.slice(start, start + ROLES_PER_PAGE).map(({ listing, role }, index) =>
          `**${start + index + 1}.** ${role ? `${role}` : `Deleted role (${listing.roleId})`} — **${listing.price.toLocaleString()} credits**`,
        );
        const components = pageCount > 1
          ? [new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder().setCustomId("role-shop:previous").setLabel("Previous").setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
              new ButtonBuilder().setCustomId("role-shop:next").setLabel("Next").setStyle(ButtonStyle.Secondary).setDisabled(page === pageCount - 1),
            )]
          : [];
        const shopEmbed = new EmbedBuilder()
          .setColor(EMBED_COLOR)
          .setTitle(`Server role shop • ${page + 1}/${pageCount}`)
          .setDescription(`${lines.join("\n")}\n\nBuy with \`!shop buy @role\`.`);
        return { embeds: [shopEmbed], components };
      };

      const shopMessage = await message.reply(buildPage(currentPage));
      if (pageCount > 1) {
        const collector = shopMessage.createMessageComponentCollector({
          componentType: ComponentType.Button,
          time: 120_000,
        });
        collector.on("collect", async (interaction) => {
          if (interaction.user.id !== message.author.id) {
            await interaction.reply({ content: "Only the person who opened this shop can change its page.", ephemeral: true });
            return;
          }
          currentPage += interaction.customId === "role-shop:next" ? 1 : -1;
          currentPage = Math.max(0, Math.min(pageCount - 1, currentPage));
          await interaction.update(buildPage(currentPage));
        });
        collector.on("end", async () => {
          await shopMessage.edit({ components: [] }).catch(() => {});
        });
      }
      return;
    }

    await message.reply({
      embeds: [new EmbedBuilder().setColor(EMBED_COLOR).setTitle("Role shop commands").setDescription([
        "`!shop` — view roles for sale",
        "`!shop buy @role` — buy a role with credits",
        "`!shop add @role <price>` — set/list a role price, e.g. `!shop add @VIP 50000` (Manage Server)",
        "`!shop edit @role <new-price>` — change an existing listing's price (Manage Server)",
        "`!shop remove @role` — remove a listing (Manage Server)",
      ].join("\n"))],
    });
  } catch (err) {
    logger.error({ err, guildId: guild.id, userId: message.author.id, subcommand }, "Role shop command failed");
    await message.reply(replyEmbed("Role shop error", "The shop couldn't complete that command. Please try again.")).catch(() => {});
  }
}
