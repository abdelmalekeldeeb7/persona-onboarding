// Session persistence. Postgres when DATABASE_URL is set (Railway), JSON file otherwise.
import fs from 'node:fs';
import path from 'node:path';

let pool = null;
const FILE = path.resolve(process.env.SESSION_FILE || '.data/sessions.json');
let mem = new Map();

// Verified TLS by default. Railway's private network (*.railway.internal) never leaves their
// infrastructure and doesn't speak TLS; PGSSL=no-verify is an explicit, logged escape hatch.
function pgSsl(url) {
  if (process.env.PGSSL === 'false') return false;
  if (process.env.PGSSL === 'no-verify') { console.warn('[store] TLS certificate verification DISABLED (PGSSL=no-verify)'); return { rejectUnauthorized: false }; }
  let host = '';
  try { host = new URL(url).hostname; } catch {}
  if (host.endsWith('.railway.internal') || host === 'localhost' || host === '127.0.0.1') return false;
  return { rejectUnauthorized: true };
}

export async function initStore() {
  if (process.env.DATABASE_URL) {
    const { default: pg } = await import('pg');
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: pgSsl(process.env.DATABASE_URL),
    });
    await pool.query(`create table if not exists sessions (
      id text primary key, data jsonb not null, updated_at timestamptz not null default now())`);
    console.log('[store] postgres');
  } else {
    try { mem = new Map(Object.entries(JSON.parse(fs.readFileSync(FILE, 'utf8')))); } catch {}
    console.log('[store] file', FILE);
  }
}

let flushTimer = null;
function flushFile() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(Object.fromEntries(mem)));
  }, 200);
}

export async function getSession(id) {
  if (pool) {
    const r = await pool.query('select data from sessions where id=$1', [id]);
    return r.rows[0]?.data ?? null;
  }
  const s = mem.get(id);
  return s ? structuredClone(s) : null;
}

export async function saveSession(s) {
  s.updatedAt = Date.now();
  if (pool) {
    await pool.query(
      `insert into sessions(id,data,updated_at) values($1,$2,now())
       on conflict(id) do update set data=excluded.data, updated_at=now()`,
      [s.id, s]
    );
    return;
  }
  mem.set(s.id, structuredClone(s));
  flushFile();
}
