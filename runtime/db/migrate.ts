import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
const TRACKING_TABLE = "public.kuronami_schema_migrations";

interface Migration {
  id: string;
  name: string;
  upPath: string;
  downPath: string;
}

async function loadMigrations(): Promise<Migration[]> {
  const files = await readdir(MIGRATIONS_DIR);
  const byId = new Map<string, Partial<Migration> & { id: string; name: string }>();

  for (const file of files) {
    const match = file.match(/^(\d+)_(.+)\.(up|down)\.sql$/);
    if (!match) continue;
    const [, id, name, direction] = match;
    const entry = byId.get(id) ?? { id, name };
    if (direction === "up") entry.upPath = path.join(MIGRATIONS_DIR, file);
    else entry.downPath = path.join(MIGRATIONS_DIR, file);
    byId.set(id, entry);
  }

  const migrations: Migration[] = [];
  for (const entry of byId.values()) {
    if (!entry.upPath || !entry.downPath) {
      throw new Error(`Migration ${entry.id}_${entry.name} fehlt up- oder down-Datei`);
    }
    migrations.push(entry as Migration);
  }

  return migrations.sort((a, b) => a.id.localeCompare(b.id));
}

async function ensureTrackingTable(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE} (
      id text PRIMARY KEY,
      name text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function getAppliedIds(client: Client): Promise<Set<string>> {
  const result = await client.query<{ id: string }>(`SELECT id FROM ${TRACKING_TABLE} ORDER BY id`);
  return new Set(result.rows.map((row) => row.id));
}

async function up(client: Client): Promise<void> {
  const migrations = await loadMigrations();
  const applied = await getAppliedIds(client);
  const pending = migrations.filter((m) => !applied.has(m.id));

  if (pending.length === 0) {
    console.log("Keine ausstehenden Migrationen.");
    return;
  }

  for (const migration of pending) {
    const sql = await readFile(migration.upPath, "utf8");
    console.log(`up   ${migration.id}_${migration.name}`);
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query(`INSERT INTO ${TRACKING_TABLE} (id, name) VALUES ($1, $2)`, [
        migration.id,
        migration.name,
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
}

async function down(client: Client, all: boolean): Promise<void> {
  const migrations = await loadMigrations();
  const byId = new Map(migrations.map((m) => [m.id, m]));
  const applied = [...(await getAppliedIds(client))].sort().reverse();

  if (applied.length === 0) {
    console.log("Keine angewendeten Migrationen.");
    return;
  }

  const toRevert = all ? applied : [applied[0]];

  for (const id of toRevert) {
    const migration = byId.get(id);
    if (!migration) throw new Error(`Migrationsdatei für ${id} nicht gefunden`);
    const sql = await readFile(migration.downPath, "utf8");
    console.log(`down ${migration.id}_${migration.name}`);
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query(`DELETE FROM ${TRACKING_TABLE} WHERE id = $1`, [id]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const all = process.argv.includes("--all");

  if (command !== "up" && command !== "down") {
    console.error("Verwendung: migrate.ts <up|down> [--all]");
    process.exitCode = 1;
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL ist nicht gesetzt");
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await ensureTrackingTable(client);
    if (command === "up") await up(client);
    else await down(client, all);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
