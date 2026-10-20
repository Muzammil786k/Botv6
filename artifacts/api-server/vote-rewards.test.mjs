import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const apiRequire = createRequire(new URL("./package.json", import.meta.url));
const typescript = apiRequire("typescript");

function loadTypeScriptModule(relativePath, mocks = {}) {
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const compiled = typescript.transpileModule(source, {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module,
    exports: module.exports,
    URL,
    Buffer,
    process,
    require: (specifier) => Object.hasOwn(mocks, specifier) ? mocks[specifier] : apiRequire(specifier),
  }, { filename: relativePath });
  return module.exports;
}

const webhookSecurity = loadTypeScriptModule("./src/bot/voteWebhookSecurity.ts");
const rewardEmbeds = loadTypeScriptModule("./src/bot/voteRewardEmbeds.ts", {
  "@workspace/db": { botVoteRewardClaimsTable: {}, botVoteRewardSettingsTable: {}, db: {} },
  "drizzle-orm": { eq: () => undefined },
  "../lib/logger": { logger: { warn() {} } },
});
const topggEventsTable = { voteId: "vote_id" };
const discadiaEventsTable = { voteId: "vote_id", guildId: "guild_id", userId: "user_id", receivedAt: "received_at" };
const webhookDbState = { topggReceipt: null, duplicateTopgg: false, recentDiscadiaEvent: false, discadiaReceipt: null };
const webhookDb = {
  insert(table) {
    let values;
    const builder = {
      values(input) { values = input; return this; },
      onConflictDoNothing() { return this; },
      async returning() {
        if (table === topggEventsTable) {
          webhookDbState.topggReceipt = values;
          return webhookDbState.duplicateTopgg ? [] : [{ voteId: values.voteId }];
        }
        webhookDbState.discadiaReceipt = values;
        return [];
      },
    };
    return builder;
  },
  async transaction(callback) {
    const transaction = {
      execute: async () => undefined,
      select: () => ({ from: () => ({ where: () => ({ limit: async () => webhookDbState.recentDiscadiaEvent ? [{ voteId: "existing" }] : [] }) }) }),
      insert: () => ({ values: async (values) => { webhookDbState.discadiaReceipt = values; } }),
    };
    return callback(transaction);
  },
};
const dbTables = {
  botTopggVoteEventsTable: topggEventsTable,
  botDiscadiaVoteEventsTable: discadiaEventsTable,
  botVoteRewardClaimsTable: {},
  botVoteRewardSettingsTable: {},
  botMiningProfilesTable: {},
  db: webhookDb,
};
const drizzleFunctions = {
  and: (...conditions) => conditions,
  count: () => undefined,
  eq: (...conditions) => conditions,
  gt: (...conditions) => conditions,
  isNotNull: () => undefined,
  isNull: () => undefined,
  lte: (...conditions) => conditions,
  ne: (...conditions) => conditions,
  or: (...conditions) => conditions,
  sql: (strings, ...values) => ({ strings, values }),
  sum: () => undefined,
};
const webhookModuleMocks = {
  "@workspace/db": dbTables,
  "drizzle-orm": drizzleFunctions,
  "discord.js": { PermissionFlagsBits: { ManageRoles: 1 } },
  "../lib/logger": { logger: { error() {}, info() {}, warn() {} } },
  "./lib/logger": { logger: { error() {}, info() {}, warn() {} } },
  "./voteRewardEmbeds": { sendVoteRewardNotification: async () => undefined },
  "./voteWebhookSecurity": webhookSecurity,
};
const topggVoteHandler = loadTypeScriptModule("./src/bot/topggVotes.ts", webhookModuleMocks);
const discadiaVoteHandler = loadTypeScriptModule("./src/bot/discadiaVotes.ts", webhookModuleMocks);
const commandWarnings = [];
const commandReplies = [];
class StubEmbedBuilder {
  setColor() { return this; }
  setTitle() { return this; }
  setDescription(description) { this.description = description; return this; }
}
const voteRewardCommands = loadTypeScriptModule("./src/bot/topggVoteCommands.ts", {
  "@workspace/db": {
    botVoteRewardSettingsTable: {},
    db: new Proxy({}, { get: () => { throw new Error("Unexpected database access in command authorization test"); } }),
  },
  "drizzle-orm": { eq: () => undefined },
  "discord.js": { EmbedBuilder: StubEmbedBuilder, PermissionFlagsBits: { ManageGuild: 1, Administrator: 2, ManageRoles: 3 } },
  "../lib/logger": { logger: { warn: (fields) => commandWarnings.push(fields) } },
  "./topggVotes": { getVoteRewardStats: async () => ({ votes: 0, credits: 0 }) },
  "./voteRewardEmbeds": {
    buildVoteRewardMessage: () => ({}),
    getVoteRewardEmbedFieldKey: () => undefined,
    loadVoteRewardEmbedTemplate: async () => ({}),
    validateVoteRewardEmbedField: () => null,
  },
});

function mockRequest(body, headers = {}) {
  return {
    headers,
    async *[Symbol.asyncIterator]() { yield Buffer.from(body); },
  };
}

function mockResponse() {
  return {
    headersSent: false,
    writeHead(statusCode, headers) { this.statusCode = statusCode; this.headers = headers; this.headersSent = true; },
    end(body) { this.body = body; },
  };
}

function signTopggPayload(body, secret) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const digest = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

test("Top.gg v1 signatures bind the exact raw body and recent timestamp", () => {
  const secret = "topgg-test-secret";
  const body = Buffer.from('{"type":"vote.create"}');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body.toString("utf8")}`).digest("hex");

  assert.equal(webhookSecurity.verifyTopggSignature(`t=${timestamp},v1=${signature}`, body, secret), true);
  assert.equal(webhookSecurity.verifyTopggSignature(`t=${timestamp},v1=${signature}`, Buffer.from("altered"), secret), false);
  assert.equal(webhookSecurity.verifyTopggSignature(`t=${timestamp - 600},v1=${signature}`, body, secret), false);
  assert.equal(webhookSecurity.verifyTopggSignature("invalid", body, secret), false);
});

test("Discadia accepts only its documented payload and a strong URL token", () => {
  const payload = {
    user_id: "213698532983570432",
    guild_id: "429603128736874516",
    server_title: "Example Server",
    server_slug: "example-server",
    vote_url: "https://discadia.com/vote/example-server",
  };
  const secret = "a".repeat(64);

  assert.deepEqual({ ...webhookSecurity.parseDiscadiaVotePayload(payload) }, {
    userId: payload.user_id,
    guildId: payload.guild_id,
    serverTitle: payload.server_title,
    serverSlug: payload.server_slug,
    voteUrl: payload.vote_url,
  });
  assert.equal(webhookSecurity.parseDiscadiaVotePayload({ userId: payload.user_id, guildId: payload.guild_id }), null);
  assert.equal(webhookSecurity.parseDiscadiaVotePayload({ ...payload, vote_url: "https://attacker.example/vote/example-server" }), null);
  assert.ok(webhookSecurity.parseDiscadiaVotePayload({
    ...payload,
    server_slug: "example_server",
    vote_url: "https://discadia.com/vote/example_server",
  }));
  assert.equal(webhookSecurity.verifyDiscadiaWebhookSecret(secret, secret), true);
  assert.equal(webhookSecurity.verifyDiscadiaWebhookSecret(secret, "wrong-token"), false);
  assert.equal(webhookSecurity.verifyDiscadiaWebhookSecret("short", "short"), false);
});

test("vote embed renders placeholders and both configured Discord link buttons", () => {
  const template = {
    title: "Thanks {username}",
    description: "{user} received {credits} credits on {platform} in {server}.{role}",
    color: "#12abef",
    footerText: "Vote for us again",
    topggUrl: "https://top.gg/bot/123456789012345678/vote",
    discadiaUrl: "https://discadia.com/vote/example-server",
  };
  const payload = rewardEmbeds.buildVoteRewardMessage(template, {
    user: "<@213698532983570432>",
    username: "voter",
    credits: 150,
    role: " Role granted",
    platform: "Discadia",
    server: "Example Server",
  });
  const embed = payload.embeds[0].toJSON();
  const buttons = payload.components[0].toJSON().components;

  assert.equal(embed.title, "Thanks voter");
  assert.match(embed.description, /150 credits on Discadia in Example Server/);
  assert.equal(embed.color, 0x12abef);
  assert.equal(embed.footer.text, "Vote for us again");
  assert.equal(buttons.length, 2);
  assert.equal(buttons[0].label, "Discadia");
  assert.equal(buttons[0].style, 5);
  assert.equal(buttons[0].url, template.discadiaUrl);
  assert.equal(buttons[1].label, "Top.gg");
  assert.equal(buttons[1].style, 5);
  assert.equal(buttons[1].url, template.topggUrl);
  assert.equal(payload.allowedMentions.parse.length, 0);
  assert.equal(rewardEmbeds.validateVoteRewardEmbedField("topggurl", "javascript:alert(1)"), null);
});

test("vote reward commands enforce admin permissions and parse both platform prefixes", async () => {
  const replies = [];
  const makeMessage = (canManageGuild) => ({
    guild: { id: "429603128736874516", name: "Example Server" },
    member: { permissions: { has: () => canManageGuild } },
    author: { id: "213698532983570432", username: "voter" },
    reply: async (message) => { replies.push(message); },
  });

  commandWarnings.length = 0;
  await voteRewardCommands.handleVoteRewardCommand(makeMessage(false), ["discadia", "enable"]);
  assert.match(replies.at(-1).embeds[0].description, /Manage Server/);
  assert.equal(commandWarnings.length, 0);

  const adminMessage = makeMessage(true);
  await voteRewardCommands.handleVoteRewardCommand(adminMessage, ["topgg", "unknown"]);
  await voteRewardCommands.handleVoteRewardCommand(adminMessage, ["discadia", "unknown"]);
  assert.equal(commandWarnings[0].preferredPlatform, "topgg");
  assert.equal(commandWarnings[1].preferredPlatform, "discadia");

  const previousOwnerId = process.env.BOT_OWNER_ID;
  process.env.BOT_OWNER_ID = "213698532983570432";
  try {
    commandWarnings.length = 0;
    await voteRewardCommands.handleVoteRewardCommand(makeMessage(false), ["topgg", "unknown"]);
    assert.equal(commandWarnings[0].preferredPlatform, "topgg");
  } finally {
    if (previousOwnerId === undefined) delete process.env.BOT_OWNER_ID;
    else process.env.BOT_OWNER_ID = previousOwnerId;
  }
});

test("vote channel command persists, views, disables, and permission-gates the shared channel", async () => {
  const state = { settings: null };
  const channelId = "429603128736874517";
  const channel = {
    id: channelId,
    isTextBased: () => true,
    isSendable: () => true,
    permissionsFor: () => ({ has: () => true }),
    toString: () => "#vote-rewards",
  };
  const database = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => state.settings ? [state.settings] : [] }) }) }),
    insert: () => {
      let values;
      return {
        values(input) { values = input; return this; },
        onConflictDoUpdate: async ({ set }) => { state.settings = { ...state.settings, ...values, ...set }; },
      };
    },
  };
  const commandModule = loadTypeScriptModule("./src/bot/topggVoteCommands.ts", {
    "@workspace/db": { botVoteRewardSettingsTable: {}, db: database },
    "drizzle-orm": { eq: () => undefined },
    "discord.js": { EmbedBuilder: StubEmbedBuilder, PermissionFlagsBits: { ManageGuild: 1, Administrator: 2, ManageRoles: 3, ViewChannel: 4, SendMessages: 8 } },
    "../lib/logger": { logger: { warn() {} } },
    "./topggVotes": { getVoteRewardStats: async () => ({ votes: 0, credits: 0 }) },
    "./voteRewardEmbeds": {
      buildVoteRewardMessage: () => ({}),
      getVoteRewardEmbedFieldKey: () => undefined,
      loadVoteRewardEmbedTemplate: async () => ({}),
      validateVoteRewardEmbedField: () => null,
    },
  });
  const replies = [];
  const makeMessage = (isAdmin = true, mentionedChannel = null) => ({
    guild: {
      id: "429603128736874516",
      channels: { fetch: async (id) => id === channelId ? channel : null },
      members: { me: {}, fetchMe: async () => ({}) },
    },
    member: { permissions: { has: () => isAdmin } },
    author: { id: "213698532983570432", username: "voter" },
    mentions: { channels: { first: () => mentionedChannel } },
    reply: async (message) => { replies.push(message); },
  });

  await commandModule.handleVoteRewardCommand(makeMessage(), ["channel", channelId]);
  assert.equal(state.settings.voteRewardChannelId, channelId);
  assert.match(replies.at(-1).embeds[0].description, /#vote-rewards/);

  await commandModule.handleVoteRewardCommand(makeMessage(), ["channel"]);
  assert.match(replies.at(-1).embeds[0].description, /#vote-rewards/);

  await commandModule.handleVoteRewardCommand(makeMessage(true, channel), ["channel", `<#${channelId}>`]);
  assert.equal(state.settings.voteRewardChannelId, channelId);

  await commandModule.handleVoteRewardCommand(makeMessage(), ["channel", "none"]);
  assert.equal(state.settings.voteRewardChannelId, null);
  assert.match(replies.at(-1).embeds[0].description, /disabled/);

  await commandModule.handleVoteRewardCommand(makeMessage(false), ["channel", channelId]);
  assert.equal(state.settings.voteRewardChannelId, null);
  assert.match(replies.at(-1).embeds[0].description, /Manage Server/);
});

test("vote reward sender posts the customized embed in channel and DMs if channel is unavailable", async () => {
  const settings = {
    voteRewardChannelId: "429603128736874517",
    voteEmbedTemplate: { topggUrl: "https://top.gg/bot/123456789012345678/vote", discadiaUrl: "https://discadia.com/vote/example-server" },
    topggVoteEmbedTemplate: {},
  };
  const createSender = (fetchedChannel) => {
    const posted = [];
    const dms = [];
    const module = loadTypeScriptModule("./src/bot/voteRewardEmbeds.ts", {
      "@workspace/db": {
        botVoteRewardClaimsTable: {},
        botVoteRewardSettingsTable: {},
        db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [settings] }) }) }) },
      },
      "drizzle-orm": { eq: () => undefined },
      "../lib/logger": { logger: { warn() {} } },
    });
    const client = {
      users: { fetch: async () => ({ id: "213698532983570432", username: "voter", send: async (message) => dms.push(message) }) },
      guilds: { cache: new Map([["429603128736874516", {
        name: "Example Server",
        channels: { fetch: async () => fetchedChannel },
        roles: { cache: new Map() },
      }]]) },
    };
    if (fetchedChannel && !fetchedChannel.send) fetchedChannel.send = async (message) => posted.push(message);
    return { send: () => module.sendVoteRewardNotification(client, {
      guildId: "429603128736874516",
      userId: "213698532983570432",
      creditsAwarded: 100,
      roleId: null,
      roleStatus: "none",
      notificationStatus: "pending",
      voteId: "test-vote",
    }, "topgg"), posted, dms };
  };

  const channelSender = createSender({ isTextBased: () => true, isSendable: () => true });
  await channelSender.send();
  assert.equal(channelSender.posted.length, 1);
  assert.equal(channelSender.dms.length, 0);
  assert.equal(channelSender.posted[0].components[0].toJSON().components.length, 2);

  const fallbackSender = createSender(null);
  await fallbackSender.send();
  assert.equal(fallbackSender.posted.length, 0);
  assert.equal(fallbackSender.dms.length, 1);

  const inaccessibleSender = createSender({
    isTextBased: () => true,
    isSendable: () => true,
    send: async () => { throw new Error("Missing Send Messages permission"); },
  });
  await inaccessibleSender.send();
  assert.equal(inaccessibleSender.posted.length, 0);
  assert.equal(inaccessibleSender.dms.length, 1);
});

test("slash commands register /send and /help receives full client/member context after defer", async () => {
  class TestCollection extends Map {}
  class TestGuildMember {}
  class TestSlashCommandBuilder {
    setName(name) { this.name = name; return this; }
    setDescription() { return this; }
    addStringOption(callback) { callback(new TestSlashCommandBuilder()); return this; }
    addIntegerOption(callback) { callback(new TestSlashCommandBuilder()); return this; }
    addUserOption(callback) { callback(new TestSlashCommandBuilder()); return this; }
    addRoleOption(callback) { callback(new TestSlashCommandBuilder()); return this; }
    addBooleanOption(callback) { callback(new TestSlashCommandBuilder()); return this; }
    addChannelOption(callback) { callback(new TestSlashCommandBuilder()); return this; }
    addSubcommand(callback) { callback(new TestSlashCommandBuilder()); return this; }
    addChannelTypes() { return this; }
    setRequired() { return this; }
    setMinValue() { return this; }
    setMaxValue() { return this; }
    setMaxLength() { return this; }
    toJSON() { return { name: this.name }; }
  }
  const forwardedMessages = [];
  const slashModule = loadTypeScriptModule("./src/bot/slash.ts", {
    "discord.js": {
      SlashCommandBuilder: TestSlashCommandBuilder,
      Collection: TestCollection,
      GuildMember: TestGuildMember,
      ChannelType: new Proxy({}, { get: () => 1 }),
    },
    "./commands": { handleMessage: async (_client, message, options) => forwardedMessages.push({ message, options }) },
    "../lib/logger": { logger: { error() {}, info() {} } },
    "./social": { SOCIAL_ACTION_NAMES: [], SOCIAL_ACTIONS: {} },
    "./automation": { bumpStickyForChannel: async () => undefined },
    "./presentation": { premiumEmbed: () => ({}) },
    "./joinToCreate": { VC_HELP_TEXT: "Voice help" },
  });

  const registered = [];
  const registerClient = { guilds: { cache: new Map([["guild", { commands: { set: async (commands) => registered.push(...commands) } }]]) } };
  await slashModule.registerSlashCommands(registerClient);
  assert.ok(registered.some((command) => command.name === "send"));
  assert.ok(registered.some((command) => command.name === "help"));

  const user = { id: "213698532983570432" };
  const targetChannel = { id: "429603128736874517" };
  const authorMember = Object.assign(new TestGuildMember(), { id: user.id });
  const guild = {
    id: "429603128736874516",
    members: { cache: new Map(), fetch: async (id) => Object.assign(new TestGuildMember(), { id }) },
    roles: { cache: new Map(), fetch: async () => null },
  };
  const client = { user: { displayAvatarURL: () => "https://example.test/avatar.png" } };
  const makeInteraction = (commandName, values = {}) => ({
    commandName,
    id: `interaction-${commandName}`,
    user,
    member: { permissions: "API guild member payload" },
    guild,
    client,
    channel: { id: "429603128736874518" },
    channelId: "429603128736874518",
    options: {
      getString: (key) => values[key] ?? null,
      getInteger: () => null,
      getUser: () => null,
      getRole: () => null,
      getChannel: (key) => key === "channel" ? values.channel ?? null : null,
      getBoolean: () => false,
      getSubcommand: () => null,
    },
    deferred: false,
    replied: false,
    deferReply: async function() { this.deferred = true; },
    reply: async function() { this.replied = true; },
  });

  const helpInteraction = makeInteraction("help");
  await slashModule.handleSlashCommand(client, helpInteraction);
  assert.equal(helpInteraction.deferred, true);
  assert.equal(forwardedMessages[0].message.content, "!help");
  assert.equal(forwardedMessages[0].message.client, client);
  assert.equal(forwardedMessages[0].message.member.id, user.id);

  const sendInteraction = makeInteraction("send", { channel: targetChannel, message: "Hello members" });
  await slashModule.handleSlashCommand(client, sendInteraction);
  assert.equal(forwardedMessages[1].message.content, `!announce <#${targetChannel.id}> Hello members`);
  assert.equal(forwardedMessages[1].message.mentions.channels.get(targetChannel.id), targetChannel);
});

test("Top.gg handler rejects invalid auth, acknowledges tests, and deduplicates durable receipts", async () => {
  const previousSecret = process.env.TOPGG_WEBHOOK_SECRET;
  const previousProjectId = process.env.TOPGG_PROJECT_ID;
  process.env.TOPGG_WEBHOOK_SECRET = "topgg-test-secret";
  process.env.TOPGG_PROJECT_ID = "160105994217586689";
  webhookDbState.topggReceipt = null;
  webhookDbState.duplicateTopgg = false;
  try {
    const invalidResponse = mockResponse();
    await topggVoteHandler.handleTopggWebhook(mockRequest("{}"), invalidResponse, null);
    assert.equal(invalidResponse.statusCode, 401);

    const project = { type: "bot", platform: "discord", platform_id: process.env.TOPGG_PROJECT_ID };
    const testBody = JSON.stringify({ type: "webhook.test", data: { project } });
    const testResponse = mockResponse();
    await topggVoteHandler.handleTopggWebhook(
      mockRequest(testBody, { "x-topgg-signature": signTopggPayload(testBody, process.env.TOPGG_WEBHOOK_SECRET) }),
      testResponse,
      null,
    );
    assert.equal(testResponse.statusCode, 200);
    assert.equal(JSON.parse(testResponse.body).rewardsIssued, false);

    const voteBody = JSON.stringify({ type: "vote.create", data: {
      id: "808499215864008704",
      weight: 2,
      project,
      user: { platform_id: "213698532983570432" },
    } });
    const voteResponse = mockResponse();
    await topggVoteHandler.handleTopggWebhook(
      mockRequest(voteBody, { "x-topgg-signature": signTopggPayload(voteBody, process.env.TOPGG_WEBHOOK_SECRET) }),
      voteResponse,
      null,
    );
    assert.equal(voteResponse.statusCode, 200);
    assert.equal(webhookDbState.topggReceipt.userId, "213698532983570432");
    assert.equal(webhookDbState.topggReceipt.weight, 2);

    webhookDbState.duplicateTopgg = true;
    const duplicateResponse = mockResponse();
    await topggVoteHandler.handleTopggWebhook(
      mockRequest(voteBody, { "x-topgg-signature": signTopggPayload(voteBody, process.env.TOPGG_WEBHOOK_SECRET) }),
      duplicateResponse,
      null,
    );
    assert.equal(JSON.parse(duplicateResponse.body).duplicate, true);
  } finally {
    if (previousSecret === undefined) delete process.env.TOPGG_WEBHOOK_SECRET;
    else process.env.TOPGG_WEBHOOK_SECRET = previousSecret;
    if (previousProjectId === undefined) delete process.env.TOPGG_PROJECT_ID;
    else process.env.TOPGG_PROJECT_ID = previousProjectId;
  }
});

test("Discadia handler requires the URL token and suppresses recent duplicate callbacks", async () => {
  const previousSecret = process.env.DISCADIA_WEBHOOK_SECRET;
  const secret = "b".repeat(64);
  process.env.DISCADIA_WEBHOOK_SECRET = secret;
  webhookDbState.recentDiscadiaEvent = false;
  try {
    const body = JSON.stringify({
      user_id: "213698532983570432",
      guild_id: "429603128736874516",
      server_title: "Example Server",
      server_slug: "example-server",
      vote_url: "https://discadia.com/vote/example-server",
    });
    const unauthorizedResponse = mockResponse();
    await discadiaVoteHandler.handleDiscadiaWebhook(mockRequest(body), unauthorizedResponse, null);
    assert.equal(unauthorizedResponse.statusCode, 401);

    const acceptedResponse = mockResponse();
    await discadiaVoteHandler.handleDiscadiaWebhook(mockRequest(body), acceptedResponse, null, secret);
    assert.equal(acceptedResponse.statusCode, 200);
    assert.equal(webhookDbState.discadiaReceipt.userId, "213698532983570432");
    assert.equal(webhookDbState.discadiaReceipt.guildId, "429603128736874516");
    assert.equal(webhookDbState.discadiaReceipt.weight, 1);

    webhookDbState.recentDiscadiaEvent = true;
    const duplicateResponse = mockResponse();
    await discadiaVoteHandler.handleDiscadiaWebhook(mockRequest(body), duplicateResponse, null, secret);
    assert.equal(JSON.parse(duplicateResponse.body).duplicate, true);
  } finally {
    if (previousSecret === undefined) delete process.env.DISCADIA_WEBHOOK_SECRET;
    else process.env.DISCADIA_WEBHOOK_SECRET = previousSecret;
  }
});