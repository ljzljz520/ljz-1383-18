// db.js — sql.js (WASM SQLite) 持久层：内存库 + 每个写事务后原子落盘
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'album.sqlite');

let db = null;
let SQL = null;

const SCHEMA = `
PRAGMA journal_mode=MEMORY;
CREATE TABLE IF NOT EXISTS albums(
  id TEXT PRIMARY KEY, title TEXT, created_at INTEGER,
  head_version INTEGER DEFAULT 0,   -- 结构版本：每次结构变更 +1（离线合并的基准）
  generation INTEGER DEFAULT 0      -- 发布代次：每次发布/撤回/撤下 +1
);
CREATE TABLE IF NOT EXISTS chapters(
  id TEXT PRIMARY KEY, album_id TEXT, title TEXT, body TEXT,
  order_key REAL, version INTEGER DEFAULT 1,
  updated_at INTEGER, deleted INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS media(
  id TEXT PRIMARY KEY, album_id TEXT, filename TEXT, blob_path TEXT,
  caption TEXT, status TEXT DEFAULT 'processing',  -- processing|ready|failed
  width INTEGER, height INTEGER, variant_of TEXT,  -- variant_of: 脱敏变体指向原图
  version INTEGER DEFAULT 1, updated_at INTEGER, deleted INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS nodes(
  id TEXT PRIMARY KEY, album_id TEXT, label TEXT,
  lat REAL, lng REAL,                 -- 精确坐标（私密）
  geohash5 TEXT,                      -- 城市级粗粒度（可公开降级）
  order_key REAL, version INTEGER DEFAULT 1,
  published INTEGER DEFAULT 1,        -- 撤下=0
  updated_at INTEGER, deleted INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS companions(
  id TEXT PRIMARY KEY, album_id TEXT, name TEXT, contact TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS consents(
  companion_id TEXT, album_id TEXT, scope TEXT,  -- name|contact|exact_location
  status TEXT DEFAULT 'granted',                 -- granted|revoked
  version INTEGER DEFAULT 1, updated_at INTEGER,
  PRIMARY KEY(companion_id, album_id, scope)
);
-- 稳定引用：正文/图注通过 ref 指向实体，与章节顺序解耦
CREATE TABLE IF NOT EXISTS refs(
  id TEXT PRIMARY KEY, chapter_id TEXT, ref_type TEXT, -- media|node|companion
  ref_id TEXT, anchor TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS ops(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, album_id TEXT, client_id TEXT,
  base_version INTEGER, op_type TEXT, payload TEXT, lamport INTEGER,
  applied_at INTEGER, status TEXT, conflict_note TEXT
);
CREATE TABLE IF NOT EXISTS snapshots(
  id TEXT PRIMARY KEY, album_id TEXT, generation INTEGER, share_token TEXT,
  policy TEXT, allowed_fields TEXT, payload TEXT,
  status TEXT DEFAULT 'current',      -- current|superseded|revoked
  created_at INTEGER, superseded_by TEXT
);
CREATE TABLE IF NOT EXISTS share_links(
  token TEXT PRIMARY KEY, album_id TEXT, policy TEXT, allowed_fields TEXT,
  snapshot_id TEXT, created_at INTEGER, revoked INTEGER DEFAULT 0
);
-- 派生物：撤回/撤下时必须重生成，不能只改当前页
CREATE TABLE IF NOT EXISTS derivatives(
  id TEXT PRIMARY KEY, album_id TEXT, kind TEXT,  -- image_variant|text_index|search_index|sitemap
  ref_type TEXT, ref_id TEXT, generation INTEGER,
  payload TEXT, status TEXT DEFAULT 'current',    -- current|stale
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS jobs(
  id TEXT PRIMARY KEY, kind TEXT, payload TEXT,
  status TEXT DEFAULT 'pending',                  -- pending|running|done|failed
  attempts INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER, error TEXT
);
-- 不可接触的外部副本：如实登记，列为不可撤回范围
CREATE TABLE IF NOT EXISTS external_copies(
  id TEXT PRIMARY KEY, album_id TEXT, companion_id TEXT, kind TEXT,
  description TEXT, controllable INTEGER DEFAULT 0, created_at INTEGER
);
`;

async function init() {
  SQL = await initSqlJs();
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    db = new SQL.Database(fs.readFileSync(DB_FILE));
  } else {
    db = new SQL.Database();
  }
  db.run(SCHEMA);
  persist();
}

function persist() {
  const data = db.export();
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, Buffer.from(data));
  fs.renameSync(tmp, DB_FILE); // 原子替换
}

// 写事务：执行后落盘。支持嵌套（内层用 SAVEPOINT）。
let txDepth = 0;
function tx(fn) {
  const outer = txDepth === 0;
  const sp = 'sp_' + txDepth;
  if (outer) db.run('BEGIN'); else db.run('SAVEPOINT ' + sp);
  txDepth++;
  try {
    const r = fn(db);
    txDepth--;
    if (outer) { db.run('COMMIT'); persist(); } else db.run('RELEASE ' + sp);
    return r;
  } catch (e) {
    txDepth--;
    try {
      if (outer) db.run('ROLLBACK');
      else { db.run('ROLLBACK TO ' + sp); db.run('RELEASE ' + sp); }
    } catch (_) { /* 忽略回滚异常 */ }
    throw e;
  }
}

function run(sql, params = []) { db.run(sql, params); }
function all(sql, params = []) {
  const stmt = db.prepare(sql); stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}
function get(sql, params = []) { return all(sql, params)[0] || null; }

module.exports = { init, tx, run, all, get, persist, DB_FILE };
