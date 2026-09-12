import pg from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const { Client } = pg;
const __dir = dirname(fileURLToPath(import.meta.url));
const MIG_DIR = join(__dir, '..', 'migrations');

// Застосовує нові .sql-міграції по черзі. Уже застосовані — пропускає.
// Ніколи не чіпає наявні дані: структура змінюється лише додаванням міграцій.
export async function runMigrations() {
  const client = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations(
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map(r => r.name));
    const files = readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      console.log('[migrate] applying', f);
      const sql = readFileSync(join(MIG_DIR, f), 'utf8');
      await client.query(sql);                    // кожен файл сам керує BEGIN/COMMIT
      await client.query('INSERT INTO schema_migrations(name) VALUES($1)', [f]);
    }
    console.log('[migrate] up to date');
  } finally {
    await client.end();
  }
}
