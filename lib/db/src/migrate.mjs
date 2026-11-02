import pg from "pg";

const { Client } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set");
}

const client = new Client({ connectionString: process.env.DATABASE_URL });

await client.connect();

try {
  await client.query("BEGIN");

  const { rows } = await client.query("SELECT to_regclass('public.bot_game_settings') AS table_name");
  if (rows[0]?.table_name) {
    await client.query('ALTER TABLE "bot_game_settings" ADD COLUMN IF NOT EXISTS "game_type" text');
    await client.query('UPDATE "bot_game_settings" SET "game_type" = \'legacy\' WHERE "game_type" IS NULL');
    await client.query('ALTER TABLE "bot_game_settings" ALTER COLUMN "game_type" SET NOT NULL');
    await client.query('ALTER TABLE "bot_game_settings" DROP CONSTRAINT IF EXISTS "bot_game_settings_pkey"');
    await client.query('ALTER TABLE "bot_game_settings" ADD CONSTRAINT "bot_game_settings_pkey" PRIMARY KEY ("guild_id", "game_type")');
  }

  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}