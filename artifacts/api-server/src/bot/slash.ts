import {
  ChatInputCommandInteraction,
  Client,
  Collection,
  GuildMember,
  Role,
  SlashCommandBuilder,
  User,
  ChannelType,
  type Message,
} from "discord.js";
import { handleMessage } from "./commands";
import { logger } from "../lib/logger";
import { SOCIAL_ACTION_NAMES, SOCIAL_ACTIONS } from "./social";
import { bumpStickyForChannel } from "./automation";
import { premiumEmbed } from "./presentation";
import { VC_HELP_TEXT } from "./joinToCreate";

const slashCommands = [
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show the complete command help menu."),
  new SlashCommandBuilder()
    .setName("gstart")
    .setDescription("Start a giveaway.")
    .addStringOption((o) => o.setName("duration").setDescription("Duration, e.g. 30s, 5m, 2h, 1d").setRequired(true))
    .addStringOption((o) => o.setName("prize").setDescription("Giveaway prize").setRequired(true))
    .addIntegerOption((o) => o.setName("winners").setDescription("Number of winners").setMinValue(1).setMaxValue(20)),
  new SlashCommandBuilder()
    .setName("gend")
    .setDescription("End a running giveaway.")
    .addStringOption((o) => o.setName("message_id").setDescription("Giveaway message ID").setRequired(true)),
  new SlashCommandBuilder()
    .setName("greroll")
    .setDescription("Reroll giveaway winner(s).")
    .addStringOption((o) => o.setName("message_id").setDescription("Giveaway message ID").setRequired(true))
    .addIntegerOption((o) => o.setName("amount").setDescription("Number of winners to reroll").setMinValue(1).setMaxValue(20)),
  new SlashCommandBuilder()
    .setName("afk")
    .setDescription("Set or clear your AFK status.")
    .addStringOption((o) => o.setName("status").setDescription("Optional AFK status")),
  new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Warn a member.")
    .addUserOption((o) => o.setName("user").setDescription("Member to warn").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("Reason").setRequired(true)),
  new SlashCommandBuilder()
    .setName("warnings")
    .setDescription("View a member's warnings.")
    .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true)),
  new SlashCommandBuilder()
    .setName("clearwarnings")
    .setDescription("Clear a member's warnings.")
    .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true)),
  new SlashCommandBuilder()
    .setName("mute")
    .setDescription("Timeout a member.")
    .addUserOption((o) => o.setName("user").setDescription("Member to mute").setRequired(true))
    .addStringOption((o) => o.setName("duration").setDescription("Duration, e.g. 30s, 5m, 2h, 1d").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("Reason")),
  new SlashCommandBuilder()
    .setName("unmute")
    .setDescription("Remove a member timeout.")
    .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true)),
  new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Kick a member.")
    .addUserOption((o) => o.setName("user").setDescription("Member to kick").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("Reason")),
  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a member.")
    .addUserOption((o) => o.setName("user").setDescription("Member to ban").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("Reason")),
  new SlashCommandBuilder()
    .setName("unban")
    .setDescription("Unban a user by ID.")
    .addStringOption((o) => o.setName("user_id").setDescription("User ID").setRequired(true)),
  new SlashCommandBuilder()
    .setName("nuke")
    .setDescription("Clone the channel and delete the old one."),
  new SlashCommandBuilder()
    .setName("slowmode")
    .setDescription("Set channel slowmode.")
    .addIntegerOption((o) => o.setName("seconds").setDescription("0 to 21600 seconds").setMinValue(0).setMaxValue(21600).setRequired(true)),
  new SlashCommandBuilder()
    .setName("lock")
    .setDescription("Lock the current channel."),
  new SlashCommandBuilder()
    .setName("unlock")
    .setDescription("Unlock the current channel."),
  new SlashCommandBuilder()
    .setName("purge")
    .setDescription("Delete recent messages.")
    .addIntegerOption((o) => o.setName("amount").setDescription("1 to 100 messages").setMinValue(1).setMaxValue(100).setRequired(true)),
  new SlashCommandBuilder()
    .setName("pb")
    .setDescription("Delete recent bot messages.")
    .addIntegerOption((o) => o.setName("amount").setDescription("1 to 100 messages").setMinValue(1).setMaxValue(100)),
  new SlashCommandBuilder()
    .setName("noprefix")
    .setDescription("Configure the no-prefix role.")
    .addRoleOption((o) => o.setName("role").setDescription("Role allowed to omit !"))
    .addBooleanOption((o) => o.setName("remove").setDescription("Remove the current no-prefix role")),
  new SlashCommandBuilder()
    .setName("socialrole")
    .setDescription("Set one or more roles required to use social commands.")
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("Require any one of these roles for social commands.")
        .addRoleOption((o) => o.setName("role").setDescription("Required role").setRequired(true))
        .addRoleOption((o) => o.setName("role2").setDescription("Additional accepted role"))
        .addRoleOption((o) => o.setName("role3").setDescription("Additional accepted role"))
        .addRoleOption((o) => o.setName("role4").setDescription("Additional accepted role"))
        .addRoleOption((o) => o.setName("role5").setDescription("Additional accepted role")),
    )
    .addSubcommand((sub) =>
      sub.setName("status").setDescription("Show the current social-command role requirement."),
    )
    .addSubcommand((sub) =>
      sub.setName("remove").setDescription("Allow everyone to use social commands again."),
    ),
  new SlashCommandBuilder()
    .setName("modrole")
    .setDescription("Restrict warning and timeout commands to a role.")
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("Choose the role allowed to warn and timeout members.")
        .addRoleOption((o) => o.setName("role").setDescription("Authorized moderator role").setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub.setName("status").setDescription("Show the configured moderation role."),
    )
    .addSubcommand((sub) =>
      sub.setName("remove").setDescription("Remove the configured moderation role."),
    ),
  new SlashCommandBuilder()
    .setName("voice")
    .setDescription("Manage your Join to Create voice channel.")
    .addSubcommand((sub) => sub.setName("help").setDescription("Show custom voice channel commands.")),
  new SlashCommandBuilder()
    .setName("userinfo")
    .setDescription("View member information.")
    .addUserOption((o) => o.setName("user").setDescription("Optional member")),
  new SlashCommandBuilder()
    .setName("serverinfo")
    .setDescription("View server information."),
  new SlashCommandBuilder()
    .setName("mc")
    .setDescription("Show online, idle, DND, and offline member counts."),
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Show bot latency and uptime."),
  new SlashCommandBuilder()
    .setName("botinfo")
    .setDescription("Show bot information."),
  new SlashCommandBuilder()
    .setName("channelinfo")
    .setDescription("Show current channel information."),
  new SlashCommandBuilder()
    .setName("avatar")
    .setDescription("Show a member's avatar.")
    .addUserOption((o) => o.setName("user").setDescription("Optional member")),
  new SlashCommandBuilder()
    .setName("quote")
    .setDescription("Create a black quote card using your avatar.")
    .addStringOption((o) => o.setName("text").setDescription("Quote text").setMaxLength(450).setRequired(true)),
  new SlashCommandBuilder()
    .setName("setquote")
    .setDescription("Choose the channel where quote cards can be created.")
    .addChannelOption((o) => o.setName("channel").setDescription("Quote text channel").addChannelTypes(ChannelType.GuildText).setRequired(true)),
  new SlashCommandBuilder()
    .setName("role")
    .setDescription("Add or remove a role.")
    .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true))
    .addRoleOption((o) => o.setName("role").setDescription("Role").setRequired(true)),
  new SlashCommandBuilder()
    .setName("nick")
    .setDescription("Change or reset a member nickname.")
    .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true))
    .addStringOption((o) => o.setName("nickname").setDescription("New nickname or reset").setRequired(true)),
  new SlashCommandBuilder()
    .setName("announce")
    .setDescription("Send an announcement embed.")
    .addChannelOption((o) => o.setName("channel").setDescription("Target channel").addChannelTypes(ChannelType.GuildText).setRequired(true))
    .addStringOption((o) => o.setName("message").setDescription("Announcement text").setRequired(true)),
  new SlashCommandBuilder()
    .setName("send")
    .setDescription("Send an announcement embed.")
    .addChannelOption((o) => o.setName("channel").setDescription("Target channel").addChannelTypes(ChannelType.GuildText).setRequired(true))
    .addStringOption((o) => o.setName("message").setDescription("Announcement text").setRequired(true)),
  new SlashCommandBuilder()
    .setName("autoreact")
    .setDescription("Configure automatic emoji reactions in a channel.")
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("React to every message in a channel.")
        .addChannelOption((o) => o.setName("channel").setDescription("Text channel").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
        .addStringOption((o) => o.setName("emoji").setDescription("Emoji to react with").setRequired(true))
        .addStringOption((o) => o.setName("trigger").setDescription("Optional text that must appear in the message").setMaxLength(120)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("Turn off automatic reactions in a channel.")
        .addChannelOption((o) => o.setName("channel").setDescription("Text channel").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("status")
        .setDescription("Show the automatic reaction for a channel.")
        .addChannelOption((o) => o.setName("channel").setDescription("Text channel").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true)),
    ),
  new SlashCommandBuilder()
    .setName("sticky")
    .setDescription("Keep one message at the bottom of a channel.")
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("Set or replace the sticky message.")
        .addChannelOption((o) => o.setName("channel").setDescription("Text channel").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
        .addStringOption((o) => o.setName("message").setDescription("Sticky text").setMaxLength(1500).setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("Remove the sticky message from a channel.")
        .addChannelOption((o) => o.setName("channel").setDescription("Text channel").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true)),
    ),
  new SlashCommandBuilder()
    .setName("jtc")
    .setDescription("Configure Join to Create temporary voice channels.")
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("Set the lobby voice channel and optional category.")
        .addChannelOption((o) => o.setName("channel").setDescription("Lobby voice channel").addChannelTypes(ChannelType.GuildVoice).setRequired(true))
        .addChannelOption((o) => o.setName("category").setDescription("Category for new channels (defaults to the lobby's category)").addChannelTypes(ChannelType.GuildCategory)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("Turn off Join to Create for this server."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("status")
        .setDescription("Show the current lobby and category."),
    ),
  new SlashCommandBuilder()
    .setName("welcome")
    .setDescription("Configure server welcome messages.")
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("Set a welcome message and channel.")
        .addChannelOption((o) => o.setName("channel").setDescription("Text channel").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
        .addStringOption((o) => o.setName("message").setDescription("Message text").setMaxLength(1800).setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub.setName("remove").setDescription("Turn off welcome messages."),
    ),
  new SlashCommandBuilder()
    .setName("wordbomb")
    .setDescription("Start a Word Bomb game in the configured games channel."),
  new SlashCommandBuilder()
    .setName("truthordare")
    .setDescription("Play Truth or Dare in the configured games channel.")
    .addUserOption((o) => o.setName("user").setDescription("Player who chooses Truth or Dare")),
  new SlashCommandBuilder()
    .setName("setgame")
    .setDescription("Choose the channel where server games can be played.")
    .addChannelOption((o) => o.setName("channel").setDescription("Games text channel").addChannelTypes(ChannelType.GuildText).setRequired(true)),
  new SlashCommandBuilder()
    .setName("setchatreward")
    .setDescription("Choose where active chat rewards are announced.")
    .addChannelOption((o) => o.setName("channel").setDescription("Reward announcement text channel").addChannelTypes(ChannelType.GuildText).setRequired(true)),
  new SlashCommandBuilder()
    .setName("wbstop")
    .setDescription("Stop the current Word Bomb game."),
  new SlashCommandBuilder()
    .setName("wbtop")
    .setDescription("Show the Word Bomb leaderboard."),
  new SlashCommandBuilder()
    .setName("airdrop")
    .setDescription("Create a timed credit airdrop for server members.")
    .addSubcommand((sub) =>
      sub
        .setName("create")
        .setDescription("Start an airdrop; entrants split the credits equally.")
        .addIntegerOption((option) => option.setName("credits").setDescription("Total credits in the airdrop").setMinValue(1).setRequired(true))
        .addStringOption((option) => option.setName("duration").setDescription("How long it stays open, e.g. 10m or 1h").setMaxLength(8).setRequired(true)),
    ),
  new SlashCommandBuilder()
    .setName("ship")
    .setDescription("Get a playful compatibility score for two members.")
    .addUserOption((o) => o.setName("user1").setDescription("First member").setRequired(true))
    .addUserOption((o) => o.setName("user2").setDescription("Second member").setRequired(true)),
  ...SOCIAL_ACTION_NAMES.map((name) =>
    new SlashCommandBuilder()
      .setName(name)
      .setDescription(SOCIAL_ACTIONS[name].description)
      .addUserOption((o) => o.setName("user").setDescription("Member to interact with").setRequired(true))
  ),
].map((command) => command.toJSON());

function mentionContent(interaction: ChatInputCommandInteraction, optionName: string, fallback = ""): string {
  const user = interaction.options.getUser(optionName);
  return user ? `<@${user.id}>` : fallback;
}

function automationCommandContent(
  interaction: ChatInputCommandInteraction,
  command: "autoreact" | "sticky" | "welcome",
): string {
  const action = interaction.options.getSubcommand(false) ?? "set";
  const channel = interaction.options.getChannel("channel");
  const channelText = channel ? `<#${channel.id}>` : "";
  const value =
    interaction.options.getString("emoji") ??
    interaction.options.getString("message") ??
    "";
  const trigger = command === "autoreact" ? interaction.options.getString("trigger") ?? "" : "";
  return `!${command} ${action} ${channelText} ${value} ${trigger}`.trim();
}

function buildLegacyContent(interaction: ChatInputCommandInteraction): string {
  const name = interaction.commandName;
  const string = (option: string) => interaction.options.getString(option) ?? "";
  const integer = (option: string) => interaction.options.getInteger(option);

  switch (name) {
    case "gstart": {
      const winners = integer("winners");
      return `!gstart ${string("duration")}${winners ? ` ${winners}` : ""} ${string("prize")}`;
    }
    case "gend":
      return `!gend ${string("message_id")}`;
    case "greroll": {
      const amount = integer("amount");
      return `!greroll ${string("message_id")}${amount ? ` ${amount}` : ""}`;
    }
    case "afk":
      return `!afk ${string("status")}`.trim();
    case "warn":
      return `!warn ${mentionContent(interaction, "user")} ${string("reason")}`.trim();
    case "warnings":
      return `!warnings ${mentionContent(interaction, "user")}`;
    case "clearwarnings":
      return `!clearwarnings ${mentionContent(interaction, "user")}`;
    case "mute":
      return `!mute ${mentionContent(interaction, "user")} ${string("duration")} ${string("reason")}`.trim();
    case "unmute":
      return `!unmute ${mentionContent(interaction, "user")}`;
    case "kick":
      return `!kick ${mentionContent(interaction, "user")} ${string("reason")}`.trim();
    case "ban":
      return `!ban ${mentionContent(interaction, "user")} ${string("reason")}`.trim();
    case "unban":
      return `!unban ${string("user_id")}`;
    case "slowmode":
      return `!slowmode ${integer("seconds")}`;
    case "purge":
      return `!purge ${integer("amount")}`;
    case "pb":
      return `!pb ${integer("amount") ?? 50}`;
    case "noprefix": {
      if (interaction.options.getBoolean("remove")) return "!noprefix remove";
      const role = interaction.options.getRole("role");
      return role ? `!noprefix <@&${role.id}>` : "!noprefix";
    }
    case "socialrole": {
      const action = interaction.options.getSubcommand(false) ?? "status";
      if (action !== "set") return `!socialrole ${action}`;
      const roles = ["role", "role2", "role3", "role4", "role5"]
        .map((name) => interaction.options.getRole(name))
        .filter((role): role is Role => role !== null);
      return roles.length
        ? `!socialrole set ${roles.map((role) => `<@&${role.id}>`).join(" ")}`
        : "!socialrole status";
    }
    case "modrole": {
      const action = interaction.options.getSubcommand(false) ?? "status";
      if (action !== "set") return `!modrole ${action}`;
      const role = interaction.options.getRole("role");
      return role ? `!modrole set <@&${role.id}>` : "!modrole status";
    }
    case "setgame": {
      const channel = interaction.options.getChannel("channel");
      return channel ? `!setgame <#${channel.id}>` : "!setgame status";
    }
    case "setchatreward": {
      const channel = interaction.options.getChannel("channel");
      return channel ? `!setchatreward <#${channel.id}>` : "!setchatreward status";
    }
    case "truthordare":
      return `!truthordare ${mentionContent(interaction, "user")}`.trim();
    case "airdrop":
      return `!airdrop ${interaction.options.getInteger("credits")} ${string("duration")}`;
    case "voice":
      return `!voice ${interaction.options.getSubcommand(false) ?? "help"}`;
    case "ship":
      return `!ship ${mentionContent(interaction, "user1")} ${mentionContent(interaction, "user2")}`.trim();
    case "userinfo":
      return `!userinfo ${mentionContent(interaction, "user")}`.trim();
    case "avatar":
      return `!avatar ${mentionContent(interaction, "user")}`.trim();
    case "quote":
      return `!quote ${string("text")}`;
    case "setquote": {
      const channel = interaction.options.getChannel("channel");
      return channel ? `!setquote <#${channel.id}>` : "!setquote status";
    }
    case "role": {
      const role = interaction.options.getRole("role");
      return `!role ${mentionContent(interaction, "user")} ${role ? `<@&${role.id}>` : ""}`.trim();
    }
    case "nick":
      return `!nick ${mentionContent(interaction, "user")} ${string("nickname")}`.trim();
    case "announce":
    case "send": {
      const channel = interaction.options.getChannel("channel");
      return `!announce ${channel ? `<#${channel.id}>` : ""} ${string("message")}`.trim();
    }
    case "jtc": {
      const action = interaction.options.getSubcommand(false) ?? "status";
      if (action !== "set") return `!jtc ${action}`;
      const lobby = interaction.options.getChannel("channel");
      const category = interaction.options.getChannel("category");
      return `!jtc set ${lobby ? `<#${lobby.id}>` : ""} ${category ? `<#${category.id}>` : ""}`.trim();
    }
    case "autoreact":
    case "sticky":
    case "welcome":
      return automationCommandContent(interaction, name);
    default:
      return `!${name}`;
  }
}

async function createMessageAdapter(interaction: ChatInputCommandInteraction, content: string): Promise<Message> {
  const guild = interaction.guild!;
  const user = interaction.user;
  const member = guild.members.cache.get(user.id) ?? (interaction.member instanceof GuildMember
    ? interaction.member
    : await guild.members.fetch(user.id).catch(() => null));
  const selectedUsers = new Collection<string, User>();
  const selectedMembers = new Collection<string, GuildMember>();
  const selectedRoles = new Collection<string, Role>();

  for (const option of ["user", "user1", "user2"]) {
    const selected = interaction.options.getUser(option);
    if (selected) {
      selectedUsers.set(selected.id, selected);
      const selectedMember = guild.members.cache.get(selected.id) ?? await guild.members.fetch(selected.id).catch(() => null);
      if (selectedMember) selectedMembers.set(selected.id, selectedMember);
    }
  }

  const selectedRole = interaction.options.getRole("role");
  const role = selectedRole
    ? guild.roles.cache.get(selectedRole.id) ?? await guild.roles.fetch(selectedRole.id).catch(() => null)
    : undefined;
  if (role) selectedRoles.set(role.id, role);

  const channel = interaction.channel;
  const mentionedChannel = interaction.options.getChannel("channel") ?? channel;
  const selectedChannels = new Collection<string, any>();
  if (mentionedChannel) selectedChannels.set(mentionedChannel.id, mentionedChannel);
  const mentions = {
    users: selectedUsers,
    members: selectedMembers,
    roles: selectedRoles,
    channels: selectedChannels,
  };

  return {
    id: interaction.id,
    content,
    author: user,
    client: interaction.client,
    guild,
    channel,
    member,
    mentions,
    reply: async (payload: unknown) => {
      if (interaction.deferred && !interaction.replied) {
        await interaction.editReply(payload as never);
        return interaction.fetchReply();
      }
      if (interaction.replied) {
        return interaction.followUp(payload as never);
      }
      await interaction.reply(payload as never);
      return interaction.fetchReply();
    },
    delete: async () => {},
  } as unknown as Message;
}

export async function registerSlashCommands(client: Client): Promise<void> {
  for (const guild of client.guilds.cache.values()) {
    try {
      await guild.commands.set(slashCommands);
    } catch (err) {
      logger.error({ err, guildId: guild.id }, "Failed to register slash commands");
    }
  }
  logger.info({ commands: slashCommands.length, guilds: client.guilds.cache.size }, "Slash commands registered");
}

export async function handleSlashCommand(client: Client, interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({
      embeds: [
        premiumEmbed(
          "❌ This command can only be used inside a server.",
          { title: "Server only" },
          client.user,
        ),
      ],
      ephemeral: true,
    });
    return;
  }

  try {
    if (interaction.commandName === "voice") {
      await interaction.reply({ content: VC_HELP_TEXT, ephemeral: true });
      return;
    }

    await interaction.deferReply();

    const content = buildLegacyContent(interaction);
    const message = await createMessageAdapter(interaction, content);
    await handleMessage(client, message, { skipAutoModeration: true });
    await bumpStickyForChannel(client, interaction.guild.id, interaction.channelId);
  } catch (err) {
    logger.error({ err, command: interaction.commandName }, "Error handling slash command");
    if (interaction.deferred && !interaction.replied) {
      await interaction
        .editReply({
          embeds: [
            premiumEmbed(
              "❌ Something went wrong while running that command.",
              { title: "Command error" },
              client.user,
            ),
          ],
        })
        .catch(() => {});
    } else if (interaction.replied) {
      await interaction.followUp({
        embeds: [
          premiumEmbed(
            "❌ Something went wrong while running that command.",
            { title: "Command error" },
            client.user,
          ),
        ],
        ephemeral: true,
      }).catch(() => {});
    } else {
      await interaction.reply({
        embeds: [
          premiumEmbed(
            "❌ Something went wrong while running that command.",
            { title: "Command error" },
            client.user,
          ),
        ],
        ephemeral: true,
      }).catch(() => {});
    }
  }
}