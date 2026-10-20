# Mainz

A Discord moderation, utility, giveaway, and Word Bomb bot.

## Run locally

```bash
pnpm install
PORT=5000 pnpm --filter @workspace/api-server run dev
```

## Railway deployment

Railway uses `railway.json` to build and start the API server. The start command pushes the Drizzle schema before starting the bot, so database tables are created or updated on deployment. Add these variables to the Railway service:

- `DATABASE_URL` — PostgreSQL connection string used by the bot
- `DISCORD_BOT_TOKEN` — Discord bot token

Railway provides `PORT` automatically.

## Join to Create voice channels

Members who join a designated lobby voice channel get their own temporary voice channel, which is deleted automatically once it is empty. Configure it with:

- `JTC_LOBBY_CHANNEL_ID` — ID of the lobby voice channel (required; the feature is disabled when unset)
- `JTC_CATEGORY_ID` — ID of the category for created channels (optional; defaults to the lobby's category)

Each created channel is explicitly visible and joinable, even when its parent category denies those permissions. Its chat welcomes and pings the owner with a single **Commands** button. Clicking it opens a private control panel with action buttons and the full command list; parameterized actions prompt for their values. Owners can also use `!voice` (aliases `!v` and `!vc`) or `/voice help`. Bumping moves a channel to the top of its category with a one-hour cooldown; bitrate is limited by the server's boost tier. Ownership passes to another member when the owner leaves.

The bot needs the Manage Channels and Move Members permissions, and the Guild Voice States gateway intent. Temporary channels are tracked in memory, so channels left over from before a restart are not cleaned up automatically.

The bot service must remain running continuously because Discord bots require a long-lived process.

## Top.gg vote rewards

The bot accepts Top.gg's signed v1 webhook at `POST /api/topgg/webhook`. Railway (or another host) must expose the service over a publicly reachable HTTPS URL so Top.gg can deliver events. The handler verifies `x-topgg-signature` against the raw request body before accepting a vote. Dashboard `webhook.test` events are acknowledged but never award rewards.

### Environment variables

Set these on the API service (Railway: **Service → Variables**):

- `TOPGG_PROJECT_ID` — the Discord application/bot ID shown for your Top.gg bot project (`data.project.platform_id` in vote events).
- `TOPGG_WEBHOOK_SECRET` — the v1 `whs_...` secret generated on the Top.gg project's **Webhooks** page. Keep it secret; do not commit it.
- `DISCORD_BOT_TOKEN` and `DATABASE_URL` — already required to run this bot.
- `BOT_OWNER_ID` — optional Discord user ID allowed to configure vote rewards even without Manage Server permission.

`.env.example` contains placeholders only. Railway already pushes the Drizzle schema during deployment.

### Top.gg webhook setup

1. Deploy the bot to a public HTTPS host and copy its public base URL.
2. Open your bot project on Top.gg, go to **Webhooks**, and add `https://YOUR-HOST/api/topgg/webhook` as the endpoint.
3. Subscribe to `vote.create` and save the webhook. Copy the generated v1 `whs_...` secret into `TOPGG_WEBHOOK_SECRET` and set `TOPGG_PROJECT_ID` to the Discord application/bot ID.
4. Redeploy/restart the API service after setting both variables.
5. Use Top.gg's **Send test** action. The endpoint returns success for `webhook.test` but intentionally gives no rewards. Then make a real vote to verify rewards.

Top.gg signs the raw request body with HMAC-SHA256 and sends the timestamp/signature in `x-topgg-signature`. Invalid signatures, wrong project IDs, and malformed votes are rejected. Vote IDs are stored uniquely before acknowledging the webhook; retries cannot issue duplicate credits. The endpoint acknowledges durable receipts promptly, then a persistent worker processes credits, roles, and DMs separately. Weekend `data.weight` (normally 1, 2 during the multiplier) multiplies the configured credit amount.

### Configure rewards per server

Run these in each Discord server. The command requires **Manage Server** permission, unless the user is configured as `BOT_OWNER_ID`:

```text
!votereward credits 100
!votereward role 123456789012345678 permanent
!votereward enable
!votereward status
!votereward stats
```

For a temporary role, replace `permanent` with a duration such as `7d`, `12h`, or `30m` (maximum 365 days). Use `!votereward role none` for credits only, `!votereward disable` to pause rewards, and `!votereward help` for syntax. The bot needs **Manage Roles**, and its highest role must be above the configured reward role.

Votes are bot-wide on Top.gg, while this bot's credits are server-scoped. Each enabled server rewards the voter only if that voter is a current member of that server. A single valid vote can therefore reward the voter in multiple enabled servers where they are a member. DM delivery is best-effort; a closed DM does not roll back credits or roles.

## Discadia vote rewards

Discadia's documented supported automation path is its listing's **custom vote webhook**. The bot accepts the documented payload at `POST /api/discadia/webhook/<token>`. Discadia documents `user_id`, `guild_id`, `server_title`, `server_slug`, and `vote_url`, but does not document a signature header or a vote/event ID. The random token in the configured HTTPS URL authenticates requests; the handler validates the documented fields and only uses settings for that exact `guild_id`.

### Environment variables

Set these on the bot service:

- `DISCADIA_WEBHOOK_SECRET` — a random, at least 32-byte URL token. Generate one with `openssl rand -hex 32`; keep it secret and do not commit it.
- `DISCORD_BOT_TOKEN` and `DATABASE_URL` — already required by the bot.

### Discadia webhook setup

1. Deploy the bot to a public HTTPS host and copy its base URL.
2. Set `DISCADIA_WEBHOOK_SECRET` on the API service and redeploy.
3. Open the Discadia listing's **Vote Webhooks** settings and add `https://YOUR-HOST/api/discadia/webhook/YOUR_64_CHARACTER_TOKEN` as a custom webhook URL. The URL token must match `DISCADIA_WEBHOOK_SECRET`; there is no separate Discadia signature/secret field in the documented setup.
4. Temporarily run `!votereward discadia disable`, then use Discadia's **Test vote** action. The documented payload has no test marker or event ID, so disable rewards during this delivery test. Check the service logs, then configure rewards and enable them after confirming the callback.
5. Configure the reward settings independently from Top.gg with `!votereward discadia ...`.

Discadia's documented payload has no unique vote ID, so exact per-event deduplication is not possible. The handler serializes callbacks for the same guild/voter in PostgreSQL and suppresses any callback if that pair has a receipt within the preceding 10 minutes. This avoids duplicate retries and concurrent delivery, but any legitimate repeat callback for that voter and guild within the same window is also suppressed. The route responds `401` for missing/incorrect tokens, `400` for malformed payloads, and acknowledges a durably stored receipt before background processing.

Top.gg and Discadia are configured independently. Use one command set for Top.gg and another for Discadia:

```text
!votereward topgg enable
!votereward topgg credits 100
!votereward topgg role 123456789012345678 7d
!votereward discadia enable
!votereward discadia credits 150
!votereward discadia role 123456789012345678 permanent
!votereward topgg status
!votereward discadia stats
```

### Vote announcement channel

Vote reward messages use the existing customizable embed and Discadia/Top.gg link buttons. By default they are sent by DM. A server administrator (or `BOT_OWNER_ID`) can select a shared announcement channel for both platforms; the bot needs **View Channel** and **Send Messages** there.

```text
!votereward channel #vote-rewards
!votereward channel
!votereward channel none
```

Use the channel mention or its ID. The setting is stored per server and survives restarts. If the configured channel is deleted, inaccessible, or cannot accept messages, the bot logs the issue and falls back to the voter DM. `none` disables channel announcements while preserving reward processing and DM notifications.

### Customize vote reward messages

Vote reward notifications use the existing reward claim. Server administrators (or `BOT_OWNER_ID`) can customize one shared template and add separate Top.gg or Discadia overrides. Any field not set in a platform override inherits the shared value.

```text
!votereward embed shared set title Thanks for voting, {username}!
!votereward embed shared set description You received {credits} credits in {server}.{role}
!votereward embed shared set color #ff3366
!votereward embed shared set author Mainz Vote Rewards
!votereward embed shared set footer Thank you for supporting the server
!votereward embed shared set success Vote reward delivered to {user}.
!votereward embed shared set topggurl https://top.gg/bot/YOUR_BOT_ID/vote
!votereward embed shared set discadiaurl https://discadia.com/server/YOUR_SERVER_ID/
!votereward embed topgg set title Thanks for your Top.gg vote, {username}!
!votereward embed discadia set color #38bdf8
!votereward embed topgg preview
!votereward embed discadia preview
```

Supported fields are `title`, `description`, `color` (`#RRGGBB`), `author`, `authoricon`, `footer`, `footericon`, `thumbnail`, `image`, `success`, `topggurl`, and `discadiaurl`. All image, icon, and button URLs must use HTTP(S). Use `none` to clear a field; clearing a platform override restores inheritance from the shared template. Reset a whole template with `!votereward embed shared|topgg|discadia reset`.

Templates support `{user}` (voter mention), `{username}`, `{credits}`, `{role}`, `{platform}`, and `{server}`. `{role}` expands to the assigned role/status text. The `success` value is the message content; title, description, author, footer, color, and media URLs configure the embed. Vote-page buttons appear only when their corresponding URL is configured. Preview posts the rendered message in the current channel and is restricted to vote-reward administrators.

Official references checked: [Discadia Vote Webhooks](https://discadia.com/help/vote-webhooks/) and [Top.gg Webhook Overview](https://docs.top.gg/webhooks/overview), plus Top.gg's [event reference](https://docs.top.gg/webhooks/events).

## Credits

The worker retries pending database events and temporary-role changes after transient failures/restarts. Missing role IDs or insufficient role hierarchy are logged and shown as role failures; credit claims remain idempotent and are not repeated.

## Credits

Members earn 20 credits from chat once per minute. Use `!credit` to check the server balance.

Credit drops appear in the configured chat every 30 minutes. The first 🌦️ reaction wins 38 Reputation, which is added to the same balance shown by `!credit` and spent in `!shop`. Server managers configure the channel with `!creditdrop setup #channel`, then set the cadence with `!creditdrop interval 1h` (30 minutes to 24 hours). Use `!creditdrop status`, `!creditdrop pause`, and `!creditdrop resume` to manage drops.

Server managers can create reusable custom embeds with `!embed new <name>`, set content with `!embed edit <name> <title|description|color|image|thumbnail|footer> <value>`, add fields with `!embed field <name> add <field name>|<value>|[inline]`, preview with `!embed show <name>`, and send with `!embed send <name> #channel`. Use `!embed list` to see saved embeds; `!embed clear <name> <field>` clears one setting. Hex colors must use `#RRGGBB`; image and thumbnail values must be HTTP(S) URLs. Existing command-response embeds can be customized by command, for example `!embed override ban color #5865F2`, then previewed with `!embed override-show ban`. Use `!embed override-clear ban color` to clear one override or `!embed override-reset ban` to restore that command's defaults. `!embed` lists the full syntax.