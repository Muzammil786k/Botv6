import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type Guild,
  type Interaction,
  type ModalSubmitInteraction,
  type Message,
} from "discord.js";
import { and, asc, eq } from "drizzle-orm";
import {
  botCustomEmbedsTable,
  botEmbedOverridesTable,
  db,
  type CustomEmbedField,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { invalidateEmbedOverrideCache } from "./presentation";
import { setGuildMessage } from "./automation";

type EditableField = "title" | "description" | "color" | "author" | "image" | "thumbnail" | "footer";
type EditableColumn = "title" | "description" | "color" | "authorText" | "imageUrl" | "thumbnailUrl" | "footerText";
type FieldValidation = { ok: true; value: string } | { ok: false; error: string };

function parseColor(value: string): string | null {
  return /^#[\da-f]{6}$/i.test(value) ? value.toUpperCase() : null;
}

function validUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function validName(value: string): boolean {
  return /^[a-z0-9_-]{1,32}$/i.test(value);
}

function embedFromSettings(settings: {
  title: string | null;
  description: string | null;
  color: string | null;
  authorText: string | null;
  imageUrl: string | null;
  thumbnailUrl: string | null;
  footerText: string | null;
  fields: CustomEmbedField[] | null;
}, fallbackTitle: string): EmbedBuilder {
  const embed = new EmbedBuilder().setTitle(settings.title ?? fallbackTitle);
  if (settings.description) embed.setDescription(settings.description);
  if (settings.color) embed.setColor(Number.parseInt(settings.color.slice(1), 16));
  if (settings.authorText) embed.setAuthor({ name: settings.authorText });
  if (settings.imageUrl) embed.setImage(settings.imageUrl);
  if (settings.thumbnailUrl) embed.setThumbnail(settings.thumbnailUrl);
  if (settings.footerText) embed.setFooter({ text: settings.footerText });
  if (settings.fields?.length) embed.addFields(settings.fields);
  return embed;
}

function validateFieldValue(
  field: EditableField,
  value: string,
): FieldValidation {
  if (!value.trim()) return { ok: false, error: "Value cannot be empty." };
  if (field === "color") {
    const color = parseColor(value.trim());
    return color
      ? { ok: true, value: color }
      : { ok: false, error: "Use a six-digit hex color, for example `#5865F2`." };
  }
  if (field === "image" || field === "thumbnail") {
    return validUrl(value.trim())
      ? { ok: true, value: value.trim() }
      : { ok: false, error: "Use a valid `http://` or `https://` image URL." };
  }
  const limit = field === "title" || field === "author" ? 256 : field === "footer" ? 2048 : 4096;
  return value.length <= limit
    ? { ok: true, value }
    : { ok: false, error: `${field} must be ${limit} characters or fewer.` };
}

function toColumn(field: EditableField): EditableColumn {
  switch (field) {
    case "title": return "title";
    case "description": return "description";
    case "color": return "color";
    case "author": return "authorText";
    case "image": return "imageUrl";
    case "thumbnail": return "thumbnailUrl";
    case "footer": return "footerText";
  }
}

async function saveSettings(
  message: Message,
  kind: "override" | "custom",
  name: string,
  field: EditableField,
  value: string,
): Promise<void> {
  const column = toColumn(field);
  if (kind === "override") {
    await db
      .insert(botEmbedOverridesTable)
      .values({ guildId: message.guild!.id, commandKey: name, [column]: value })
      .onConflictDoUpdate({
        target: [botEmbedOverridesTable.guildId, botEmbedOverridesTable.commandKey],
        set: { [column]: value, updatedAt: new Date() },
      });
    invalidateEmbedOverrideCache(message.guild!.id, name);
    return;
  }
  await db
    .insert(botCustomEmbedsTable)
    .values({ guildId: message.guild!.id, name, [column]: value })
    .onConflictDoUpdate({
      target: [botCustomEmbedsTable.guildId, botCustomEmbedsTable.name],
      set: { [column]: value, updatedAt: new Date() },
    });
}

async function clearSettings(
    message: Message,
    kind: "override" | "custom",
    name: string,
    field: EditableField,
): Promise<void> {
    const column = toColumn(field);
    const guildId = message.guild!.id;
    if (kind === "override") {
      await db
        .update(botEmbedOverridesTable)
        .set({ [column]: null, updatedAt: new Date() })
        .where(and(
          eq(botEmbedOverridesTable.guildId, guildId),
          eq(botEmbedOverridesTable.commandKey, name),
        ));
      invalidateEmbedOverrideCache(guildId, name);
      return;
    }
    await db
      .update(botCustomEmbedsTable)
      .set({ [column]: null, updatedAt: new Date() })
      .where(and(
        eq(botCustomEmbedsTable.guildId, guildId),
        eq(botCustomEmbedsTable.name, name),
      ));
}

async function saveFields(
  message: Message,
  kind: "override" | "custom",
  name: string,
  fields: CustomEmbedField[],
): Promise<void> {
  if (kind === "override") {
    await db
      .insert(botEmbedOverridesTable)
      .values({ guildId: message.guild!.id, commandKey: name, fields })
      .onConflictDoUpdate({
        target: [botEmbedOverridesTable.guildId, botEmbedOverridesTable.commandKey],
        set: { fields, updatedAt: new Date() },
      });
    return;
  }
  await db
    .insert(botCustomEmbedsTable)
    .values({ guildId: message.guild!.id, name, fields })
    .onConflictDoUpdate({
      target: [botCustomEmbedsTable.guildId, botCustomEmbedsTable.name],
      set: { fields, updatedAt: new Date() },
    });
}

const EMBED_UI_PREFIX = "embed-ui";

function embedUiId(ownerId: string, action: string, name = ""): string {
  return `${EMBED_UI_PREFIX}:${ownerId}:${action}:${name}`;
}

function embedBuilderPanel(name: string | null): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("Embed Builder")
    .setDescription(
      name
        ? `Selected embed: **${name}**\nUse the buttons below to edit, preview, post, or set it as the welcome greeting.`
        : "Create an embed, then select it here to edit and publish it. Use `!embed edit` commands any time too.",
    )
    .setFooter({ text: "Color accepts #RRGGBB • Images accept HTTP(S) URLs • Enter reset to clear a value" });
}

function embedBuilderComponents(
  ownerId: string,
  names: string[],
  selectedName: string | null,
) {
  const components = [];
  if (names.length > 0) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(embedUiId(ownerId, "select"))
      .setPlaceholder(selectedName ? `Selected: ${selectedName}` : "Choose an embed")
      .addOptions(names.slice(0, 25).map((name) => ({
        label: name,
        value: name,
        default: name === selectedName,
      })));
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
  }

  const name = selectedName ?? "";
  components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(embedUiId(ownerId, "create")).setLabel("Create").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(embedUiId(ownerId, "text", name)).setLabel("Edit Text").setStyle(ButtonStyle.Primary).setDisabled(!name),
    new ButtonBuilder().setCustomId(embedUiId(ownerId, "style", name)).setLabel("Style & Image").setStyle(ButtonStyle.Primary).setDisabled(!name),
    new ButtonBuilder().setCustomId(embedUiId(ownerId, "fields", name)).setLabel("Fields").setStyle(ButtonStyle.Secondary).setDisabled(!name),
  ));
  components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(embedUiId(ownerId, "preview", name)).setLabel("Preview").setStyle(ButtonStyle.Secondary).setDisabled(!name),
    new ButtonBuilder().setCustomId(embedUiId(ownerId, "send", name)).setLabel("Post to Channel").setStyle(ButtonStyle.Secondary).setDisabled(!name),
    new ButtonBuilder().setCustomId(embedUiId(ownerId, "welcome", name)).setLabel("Set Welcome").setStyle(ButtonStyle.Secondary).setDisabled(!name),
  ));
  return components;
}

async function savedEmbedNames(guildId: string): Promise<string[]> {
  const embeds = await db
    .select({ name: botCustomEmbedsTable.name })
    .from(botCustomEmbedsTable)
    .where(eq(botCustomEmbedsTable.guildId, guildId))
    .orderBy(asc(botCustomEmbedsTable.name));
  return embeds.map((embed) => embed.name);
}

async function openEmbedBuilder(message: Message, guildId: string): Promise<void> {
  const names = await savedEmbedNames(guildId);
  const selectedName = names[0] ?? null;
  await message.reply({
    embeds: [embedBuilderPanel(selectedName)],
    components: embedBuilderComponents(message.author.id, names, selectedName),
  });
}

function modalInput(
  id: string,
  label: string,
  style: TextInputStyle,
  options: { required?: boolean; value?: string; placeholder?: string; maxLength?: number } = {},
): ActionRowBuilder<TextInputBuilder> {
  const input = new TextInputBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setStyle(style)
    .setRequired(options.required ?? false)
    .setMaxLength(options.maxLength ?? 4000);
  if (options.value) input.setValue(options.value.slice(0, options.maxLength ?? 4000));
  if (options.placeholder) input.setPlaceholder(options.placeholder);
  return new ActionRowBuilder<TextInputBuilder>().addComponents(input);
}

async function openEmbedModal(
  interaction: ButtonInteraction,
  action: string,
  name: string,
): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId(embedUiId(interaction.user.id, `submit-${action}`, name))
    .setTitle(action === "create" ? "Create an Embed" : `Edit ${name}`);

  if (action === "create") {
    modal.addComponents(
      modalInput("name", "Embed name", TextInputStyle.Short, { required: true, maxLength: 32 }),
      modalInput("title", "Title (optional)", TextInputStyle.Short, { maxLength: 256 }),
      modalInput("description", "Description (optional)", TextInputStyle.Paragraph),
      modalInput("color", "Hex color (optional)", TextInputStyle.Short, { placeholder: "#5865F2", maxLength: 7 }),
      modalInput("image", "Image URL (optional)", TextInputStyle.Short),
    );
  } else {
    const [settings] = await db
      .select()
      .from(botCustomEmbedsTable)
      .where(and(
        eq(botCustomEmbedsTable.guildId, interaction.guildId!),
        eq(botCustomEmbedsTable.name, name),
      ))
      .limit(1);
    if (!settings) {
      await interaction.reply({ content: "That saved embed no longer exists.", ephemeral: true });
      return;
    }

    if (action === "text") {
      modal.addComponents(
        modalInput("title", "Title", TextInputStyle.Short, { value: settings.title ?? "", maxLength: 256, placeholder: "Enter reset to clear" }),
        modalInput("author", "Author", TextInputStyle.Short, { value: settings.authorText ?? "", maxLength: 256, placeholder: "Enter reset to clear" }),
        modalInput("description", "Description", TextInputStyle.Paragraph, { value: settings.description ?? "", placeholder: "Enter reset to clear" }),
      );
    } else if (action === "style") {
      modal.addComponents(
        modalInput("color", "Hex color", TextInputStyle.Short, { value: settings.color ?? "", placeholder: "#5865F2 or reset", maxLength: 20 }),
        modalInput("image", "Image URL", TextInputStyle.Short, { value: settings.imageUrl ?? "", placeholder: "https://... or reset" }),
        modalInput("thumbnail", "Thumbnail URL", TextInputStyle.Short, { value: settings.thumbnailUrl ?? "", placeholder: "https://... or reset" }),
        modalInput("footer", "Footer text", TextInputStyle.Short, { value: settings.footerText ?? "", placeholder: "Enter reset to clear", maxLength: 2048 }),
      );
    } else if (action === "fields") {
      const fields = (settings.fields ?? []).map((field) =>
        `${field.name}|${field.value}|${field.inline ? "true" : "false"}`,
      ).join("\n");
      modal.addComponents(
        modalInput("fields", "One field per line: name|value|inline", TextInputStyle.Paragraph, {
          value: fields,
          placeholder: "Status|Welcome to the server!|false",
        }),
      );
    } else if (action === "send" || action === "welcome") {
      modal.addComponents(
        modalInput("channel", "Channel name, #channel, mention, or ID", TextInputStyle.Short, {
          required: true,
          maxLength: 100,
        }),
      );
    }
  }

  await interaction.showModal(modal);
}

function findTextChannel(guild: Guild | null, value: string) {
  if (!guild) return null;
  const normalized = value.trim();
  const id = /^<#(\d{17,20})>$/.exec(normalized)?.[1]
    ?? (/^\d{17,20}$/.test(normalized) ? normalized : undefined);
  const name = normalized.replace(/^#/, "");
  const channel = id
    ? guild.channels.cache.get(id)
    : guild.channels.cache.find((candidate) => candidate.type === ChannelType.GuildText && candidate.name === name);
  return channel?.type === ChannelType.GuildText && channel.isSendable() ? channel : null;
}

async function refreshEmbedBuilder(
  interaction: ModalSubmitInteraction,
  selectedName: string,
): Promise<void> {
  if (!interaction.isFromMessage()) return;
  const names = await savedEmbedNames(interaction.guildId!);
  await interaction.message.edit({
    embeds: [embedBuilderPanel(selectedName)],
    components: embedBuilderComponents(interaction.user.id, names, selectedName),
  }).catch(() => {});
}

async function replyToEmbedModal(
  interaction: ModalSubmitInteraction,
  content: string,
): Promise<void> {
  await interaction.reply({ content, ephemeral: true });
}

async function handleEmbedModal(interaction: ModalSubmitInteraction, action: string, name: string): Promise<void> {
  const guildId = interaction.guildId!;
  if (action === "create") {
    const embedName = interaction.fields.getTextInputValue("name").trim().toLowerCase();
    if (!validName(embedName)) {
      await replyToEmbedModal(interaction, "Embed names must be 1–32 letters, numbers, `_` or `-`.");
      return;
    }
    const values: typeof botCustomEmbedsTable.$inferInsert = { guildId, name: embedName };
    for (const [field, inputId] of [["title", "title"], ["description", "description"], ["color", "color"], ["image", "image"]] as const) {
      const raw = interaction.fields.getTextInputValue(inputId).trim();
      if (!raw) continue;
      const validated = validateFieldValue(field, raw);
      if (!validated.ok) {
        await replyToEmbedModal(interaction, validated.error);
        return;
      }
      values[toColumn(field)] = validated.value;
    }
    const [created] = await db.insert(botCustomEmbedsTable)
      .values(values)
      .onConflictDoNothing()
      .returning({ name: botCustomEmbedsTable.name });
    if (!created) {
      await replyToEmbedModal(interaction, `Embed \`${embedName}\` already exists. Select it and use Edit Text or Style.`);
      return;
    }
    await refreshEmbedBuilder(interaction, embedName);
    await replyToEmbedModal(interaction, `Created \`${embedName}\`. Select it in the builder to continue editing.`);
    return;
  }

  if (action === "fields") {
    const raw = interaction.fields.getTextInputValue("fields").trim();
    const lines = raw ? raw.split(/\r?\n/).filter((line) => line.trim()) : [];
    if (lines.length > 25) {
      await replyToEmbedModal(interaction, "Embeds support up to 25 fields.");
      return;
    }
    const fields: CustomEmbedField[] = [];
    for (const line of lines) {
      const parts = line.split("|");
      const fieldName = parts.shift()?.trim() ?? "";
      let inline: boolean | undefined;
      const finalPart = parts.at(-1)?.trim().toLowerCase();
      if (finalPart === "true" || finalPart === "false") inline = finalPart === "true";
      const value = (inline === undefined ? parts.join("|") : parts.slice(0, -1).join("|")).trim();
      if (!fieldName || !value || fieldName.length > 256 || value.length > 1024) {
        await replyToEmbedModal(interaction, "Each line must be `name|value|inline`; names max 256 and values max 1024 characters.");
        return;
      }
      fields.push({ name: fieldName, value, ...(inline === undefined ? {} : { inline }) });
    }
    await db.update(botCustomEmbedsTable)
      .set({ fields, updatedAt: new Date() })
      .where(and(
        eq(botCustomEmbedsTable.guildId, guildId),
        eq(botCustomEmbedsTable.name, name),
      ));
    await replyToEmbedModal(interaction, fields.length ? `Updated ${fields.length} embed field(s).` : "Cleared embed fields.");
    return;
  }

  if (action === "send" || action === "welcome") {
    const channelInput = interaction.fields.getTextInputValue("channel");
    const channel = findTextChannel(interaction.guild, channelInput);
    if (!channel) {
      await replyToEmbedModal(interaction, "Couldn't find a sendable text channel. Enter its name, mention, or ID.");
      return;
    }
    const [settings] = await db.select().from(botCustomEmbedsTable).where(and(
      eq(botCustomEmbedsTable.guildId, guildId),
      eq(botCustomEmbedsTable.name, name),
    )).limit(1);
    if (!settings) {
      await replyToEmbedModal(interaction, "That saved embed no longer exists.");
      return;
    }
    if (action === "welcome") {
      await setGuildMessage(guildId, "welcome", channel.id, `{{embed:${name}}}`);
      await replyToEmbedModal(interaction, `Welcome embed \`${name}\` is now active in #${channel.name}.`);
    } else {
      await channel.send({ embeds: [embedFromSettings(settings, name)] });
      await replyToEmbedModal(interaction, `Posted \`${name}\` in #${channel.name}.`);
    }
    return;
  }

  const fields: Array<[EditableField, string]> = action === "text"
    ? [["title", "title"], ["author", "author"], ["description", "description"]]
    : [["color", "color"], ["image", "image"], ["thumbnail", "thumbnail"], ["footer", "footer"]];
  const updates: Partial<Record<"title" | "description" | "color" | "authorText" | "imageUrl" | "thumbnailUrl" | "footerText", string | null>> = {};
  for (const [field, inputId] of fields) {
    const raw = interaction.fields.getTextInputValue(inputId).trim();
    if (!raw) continue;
    const column = toColumn(field) as keyof typeof updates;
    if (raw.toLowerCase() === "reset") {
      updates[column] = null;
      continue;
    }
    const validated = validateFieldValue(field, raw);
    if (!validated.ok) {
      await replyToEmbedModal(interaction, validated.error);
      return;
    }
    updates[column] = validated.value;
  }
  if (!Object.keys(updates).length) {
    await replyToEmbedModal(interaction, "No changes entered. Use `reset` to clear a value.");
    return;
  }
  await db.update(botCustomEmbedsTable)
    .set({ ...updates, updatedAt: new Date() })
    .where(and(
      eq(botCustomEmbedsTable.guildId, guildId),
      eq(botCustomEmbedsTable.name, name),
    ));
  await replyToEmbedModal(interaction, `Updated \`${name}\`.`);
}

export async function handleEmbedInteraction(interaction: Interaction): Promise<void> {
  if (!(
    interaction.isButton() ||
    interaction.isStringSelectMenu() ||
    interaction.isModalSubmit()
  ) || !interaction.customId.startsWith(`${EMBED_UI_PREFIX}:`)) return;

  const [, ownerId, action, name = ""] = interaction.customId.split(":");
  if (interaction.user.id !== ownerId) {
    await interaction.reply({ content: "Only the person who opened this embed builder can use it.", ephemeral: true });
    return;
  }
  if (!interaction.guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: "You need **Manage Server** permission to manage embeds.", ephemeral: true });
    return;
  }

  try {
    if (interaction.isStringSelectMenu()) {
      const selectedName = interaction.values[0];
      if (!selectedName || !validName(selectedName)) {
        await interaction.reply({ content: "Select a valid saved embed.", ephemeral: true });
        return;
      }
      const names = await savedEmbedNames(interaction.guildId);
      if (!names.includes(selectedName)) {
        await interaction.reply({ content: "That saved embed no longer exists.", ephemeral: true });
        return;
      }
      await interaction.update({
        embeds: [embedBuilderPanel(selectedName)],
        components: embedBuilderComponents(ownerId, names, selectedName),
      });
      return;
    }

    if (interaction.isButton()) {
      if (action === "create") {
        await openEmbedModal(interaction, "create", "");
        return;
      }
      if (!name) {
        await interaction.reply({ content: "Create or select an embed first.", ephemeral: true });
        return;
      }
      if (action === "preview") {
        const [settings] = await db.select().from(botCustomEmbedsTable).where(and(
          eq(botCustomEmbedsTable.guildId, interaction.guildId),
          eq(botCustomEmbedsTable.name, name),
        )).limit(1);
        if (!settings) {
          await interaction.reply({ content: "That saved embed no longer exists.", ephemeral: true });
          return;
        }
        await interaction.reply({ embeds: [embedFromSettings(settings, name)], ephemeral: true });
        return;
      }
      await openEmbedModal(interaction, action, name);
      return;
    }

    if (action.startsWith("submit-")) {
      await handleEmbedModal(interaction, action.slice("submit-".length), name);
    }
  } catch (error) {
    logger.error({ err: error, guildId: interaction.guildId, action }, "Embed builder interaction failed");
    const response = { content: "Could not update this embed. Please try again.", ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.followUp(response);
    else await interaction.reply(response);
  }
}

export async function handleEmbedCommand(message: Message): Promise<void> {
  const guild = message.guild;
  if (!guild) return;
  const member =
    message.member ?? (await guild.members.fetch(message.author.id).catch(() => null));
  if (!member?.permissions.has(PermissionFlagsBits.ManageGuild)) {
    await message.reply("❌ You need **Manage Server** permission to manage embeds.");
    return;
  }

  const match = /^!embed\s+(\S+)(?:\s+([\s\S]*))?$/i.exec(message.content.trim());
  const action = match?.[1]?.toLowerCase() ?? "help";
  const rest = match?.[2]?.trim() ?? "";

  try {
    if (action === "help") {
      await openEmbedBuilder(message, guild.id);
      return;
    }

    if (action === "new" || action === "create") {
      const name = rest.toLowerCase();
      if (!validName(name)) {
        await message.reply("❌ Embed names must be 1–32 letters, numbers, `_` or `-`.");
        return;
      }
      await db
        .insert(botCustomEmbedsTable)
        .values({ guildId: guild.id, name })
        .onConflictDoNothing();
      await message.reply(`✅ Embed \`${name}\` is ready to edit. Use \`!embed edit ${name} title <text>\`.`);
      return;
    }

    if (action === "list") {
      const embeds = await db
        .select({ name: botCustomEmbedsTable.name })
        .from(botCustomEmbedsTable)
        .where(eq(botCustomEmbedsTable.guildId, guild.id));
      await message.reply(
        embeds.length
          ? `Saved embeds: ${embeds.map((embed) => `\`${embed.name}\``).join(", ")}`
          : "ℹ️ No saved custom embeds yet. Start with `!embed new <name>`.",
      );
      return;
    }

    if (action === "edit" || action === "override") {
      const editMatch = /^(\S+)\s+(title|description|color|author|image|thumbnail|footer)\s+([\s\S]+)$/i.exec(rest);
      if (!editMatch) {
        await message.reply("❌ Usage: `!embed edit <name> <field> <value>` or `!embed override <command> <field> <value>`.");
        return;
      }
      const kind = action === "edit" ? "custom" : "override";
      const name = kind === "override"
        ? editMatch[1]!.replace(/^!|^\//, "").toLowerCase()
        : editMatch[1]!.toLowerCase();
      if (kind === "custom" && !validName(name)) {
        await message.reply("❌ Invalid embed name.");
        return;
      }
      const field = editMatch[2]!.toLowerCase() as EditableField;
      const validated = validateFieldValue(field, editMatch[3]!.trim());
      if (!validated.ok) {
        await message.reply(`❌ ${validated.error}`);
        return;
      }
      await saveSettings(message, kind, name, field, validated.value);
      if (kind === "override") invalidateEmbedOverrideCache(guild.id, name);
      await message.reply(`✅ ${field} updated for ${kind === "custom" ? `embed \`${name}\`` : `!${name} embeds`}.`);
      return;
    }

    if (action === "clear" || action === "override-clear") {
      const clearMatch = /^(\S+)\s+(title|description|color|author|image|thumbnail|footer)$/i.exec(rest);
      if (!clearMatch) {
        await message.reply("❌ Usage: `!embed clear <name> <field>` or `!embed override-clear <command> <field>`.");
        return;
      }
      const kind = action === "clear" ? "custom" : "override";
      const name = kind === "override"
        ? clearMatch[1]!.replace(/^!|^\//, "").toLowerCase()
        : clearMatch[1]!.toLowerCase();
      if (kind === "custom" && !validName(name)) {
        await message.reply("❌ Invalid embed name.");
        return;
      }
      const field = clearMatch[2]!.toLowerCase() as EditableField;
      await clearSettings(message, kind, name, field);
      await message.reply(`✅ The ${field} customization was cleared.`);
      return;
    }

    if (action === "field" || action === "override-field") {
      const fieldMatch = /^(\S+)\s+(add|clear|remove)(?:\s+([\s\S]+))?$/i.exec(rest);
      if (!fieldMatch) {
        await message.reply("❌ Usage: `!embed field <name> add <name>|<value>|[inline]` or `clear`; command overrides use `!embed override-field <command> ...`.");
        return;
      }
      const kind = action === "field" ? "custom" : "override";
      const name = kind === "override"
        ? fieldMatch[1]!.replace(/^!|^\//, "").toLowerCase()
        : fieldMatch[1]!.toLowerCase();
      if (kind === "custom" && !validName(name)) {
        await message.reply("❌ Invalid embed name.");
        return;
      }
      const table = kind === "custom" ? botCustomEmbedsTable : botEmbedOverridesTable;
      const [saved] = await db
        .select({ fields: table.fields })
        .from(table)
        .where(kind === "custom"
          ? and(eq(botCustomEmbedsTable.guildId, guild.id), eq(botCustomEmbedsTable.name, name))
          : and(eq(botEmbedOverridesTable.guildId, guild.id), eq(botEmbedOverridesTable.commandKey, name)));
      let fields = saved?.fields ?? [];
      const fieldAction = fieldMatch[2]!.toLowerCase();
      if (fieldAction === "clear") {
        fields = [];
      } else if (fieldAction === "remove") {
        const index = Number(fieldMatch[3]);
        if (!Number.isInteger(index) || index < 1 || index > fields.length) {
          await message.reply(`❌ Choose a field number from 1 to ${fields.length}.`);
          return;
        }
        fields = fields.filter((_, fieldIndex) => fieldIndex !== index - 1);
      } else {
        const [fieldName, value, inlineText] = (fieldMatch[3] ?? "").split("|");
        if (!fieldName?.trim() || !value?.trim()) {
          await message.reply("❌ Provide a field as `name|value|inline` (the final `|inline` is optional).");
          return;
        }
        if (fields.length >= 25 || fieldName.length > 256 || value.length > 1024) {
          await message.reply("❌ Embeds allow up to 25 fields; field names are limited to 256 and values to 1024 characters.");
          return;
        }
        const inline = inlineText?.trim().toLowerCase();
        if (inline && inline !== "true" && inline !== "false") {
          await message.reply("❌ The optional inline value must be `true` or `false`.");
          return;
        }
        fields = [...fields, { name: fieldName.trim(), value: value.trim(), ...(inline ? { inline: inline === "true" } : {}) }];
      }
      await saveFields(message, kind, name, fields);
      if (kind === "override") invalidateEmbedOverrideCache(guild.id, name);
      await message.reply(`✅ Embed fields ${fieldAction === "clear" ? "cleared" : fieldAction === "remove" ? "updated" : "updated"}.`);
      return;
    }

    if (action === "show" || action === "override-show") {
      const name = rest.replace(/^!|^\//, "").toLowerCase();
      if (action === "show" && !validName(name)) {
        await message.reply("❌ Invalid embed name.");
        return;
      }
      const [settings] = action === "show"
        ? await db.select().from(botCustomEmbedsTable).where(and(
          eq(botCustomEmbedsTable.guildId, guild.id),
          eq(botCustomEmbedsTable.name, name),
        ))
        : await db.select().from(botEmbedOverridesTable).where(and(
          eq(botEmbedOverridesTable.guildId, guild.id),
          eq(botEmbedOverridesTable.commandKey, name),
        ));
      if (!settings) {
        await message.reply("ℹ️ No saved embed settings were found.");
        return;
      }
      const title = "name" in settings ? name : `!${name}`;
      await message.reply({ embeds: [embedFromSettings(settings, `${title} embed preview`)] });
      return;
    }

    if (action === "send") {
      const sendMatch = /^(\S+)\s+<#(\d{17,20})>$/i.exec(rest);
      if (!sendMatch || !validName(sendMatch[1]!)) {
        await message.reply("❌ Usage: `!embed send <name> #channel`.");
        return;
      }
      const [settings] = await db
        .select()
        .from(botCustomEmbedsTable)
        .where(and(
          eq(botCustomEmbedsTable.guildId, guild.id),
          eq(botCustomEmbedsTable.name, sendMatch[1]!.toLowerCase()),
        ));
      const channel = guild.channels.cache.get(sendMatch[2]!);
      if (!settings || !channel || channel.type !== ChannelType.GuildText || !channel.isSendable()) {
        await message.reply("❌ Embed not found or the target must be a sendable server text channel.");
        return;
      }
      const embed = embedFromSettings(settings, settings.name);
      if (!settings.title && !settings.description && !settings.authorText && !settings.fields.length && !settings.imageUrl && !settings.thumbnailUrl) {
        await message.reply("❌ Add some content before sending this embed.");
        return;
      }
      await channel.send({ embeds: [embed] });
      await message.reply(`✅ Embed \`${settings.name}\` sent to ${channel}.`);
      return;
    }

    if (action === "delete") {
      const name = rest.toLowerCase();
      if (!validName(name)) {
        await message.reply("❌ Invalid embed name.");
        return;
      }
      const deleted = await db
        .delete(botCustomEmbedsTable)
        .where(and(
          eq(botCustomEmbedsTable.guildId, guild.id),
          eq(botCustomEmbedsTable.name, name),
        ))
        .returning({ name: botCustomEmbedsTable.name });
      await message.reply(deleted.length ? `✅ Embed \`${name}\` deleted.` : "ℹ️ That embed does not exist.");
      return;
    }

    if (action === "override-reset") {
      const name = rest.replace(/^!|^\//, "").toLowerCase();
      if (!/^[a-z0-9_-]{1,32}$/.test(name)) {
        await message.reply("❌ Provide a command name, for example `!embed override-reset ban`.");
        return;
      }
      const deleted = await db
        .delete(botEmbedOverridesTable)
        .where(and(
          eq(botEmbedOverridesTable.guildId, guild.id),
          eq(botEmbedOverridesTable.commandKey, name),
        ))
        .returning({ commandKey: botEmbedOverridesTable.commandKey });
      invalidateEmbedOverrideCache(guild.id, name);
      await message.reply(deleted.length ? `✅ Customizations for !${name} were reset.` : "ℹ️ No customizations were set for that command.");
      return;
    }

    await message.reply("❌ Unknown embed action. Use `!embed` to see available commands.");
  } catch (error) {
    logger.error({ err: error, guildId: guild.id, action }, "Embed customization command failed");
    await message.reply("❌ Could not update embed settings. Please try again.");
  }
}
