// ============================================================
// БД: соответствие ext_id (Atrucks) <-> cargo_id (ATI)
// Используется встроенный node:sqlite (Node.js >= 22.5, experimental)
// ============================================================

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const config = require('./config');

const dbDir = path.dirname(config.db.path);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new DatabaseSync(config.db.path);
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
  CREATE TABLE IF NOT EXISTS mapping (
    ext_id        TEXT PRIMARY KEY,
    atrucks_id    INTEGER,
    ati_cargo_id  TEXT,
    logist_token  TEXT,
    modified      REAL,
    logic_version INTEGER DEFAULT 0,
    first_seen_at TEXT DEFAULT (datetime('now')),
    last_seen_at  TEXT DEFAULT (datetime('now')),
    last_synced_at TEXT
  );
`);

// Миграция для баз, созданных до появления logic_version (ALTER TABLE
// ADD COLUMN IF NOT EXISTS не поддерживается стандартным SQLite —
// просто пробуем и игнорируем ошибку, если колонка уже есть).
try {
  db.exec('ALTER TABLE mapping ADD COLUMN logic_version INTEGER DEFAULT 0;');
} catch (err) {
  // колонка уже существует — это нормально
}

db.exec(`
  CREATE TABLE IF NOT EXISTS city_cache (
    name      TEXT PRIMARY KEY,
    city_id   TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

const stmts = {
  get: db.prepare('SELECT * FROM mapping WHERE ext_id = ?'),
  upsert: db.prepare(`
    INSERT INTO mapping (ext_id, atrucks_id, ati_cargo_id, logist_token, modified, logic_version, last_seen_at, last_synced_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(ext_id) DO UPDATE SET
      atrucks_id = excluded.atrucks_id,
      ati_cargo_id = excluded.ati_cargo_id,
      logist_token = excluded.logist_token,
      modified = excluded.modified,
      logic_version = excluded.logic_version,
      last_seen_at = datetime('now'),
      last_synced_at = datetime('now')
  `),
  deleteByExtId: db.prepare('DELETE FROM mapping WHERE ext_id = ?'),
  all: db.prepare('SELECT * FROM mapping'),

  getCity: db.prepare('SELECT city_id FROM city_cache WHERE name = ?'),
  putCity: db.prepare(`
    INSERT INTO city_cache (name, city_id) VALUES (?, ?)
    ON CONFLICT(name) DO UPDATE SET city_id = excluded.city_id
  `),
};

function getMapping(extId) {
  return stmts.get.get(extId);
}

function upsertMapping({ ext_id, atrucks_id, ati_cargo_id, logist_token, modified, logic_version }) {
  stmts.upsert.run(ext_id, atrucks_id, ati_cargo_id, logist_token || null, modified, logic_version || 0);
}

function deleteMapping(extId) {
  stmts.deleteByExtId.run(extId);
}

function getAllMappings() {
  return stmts.all.all();
}

// Возвращает записи, которых не было в текущем проходе (seenExtIds)
function getStaleMappings(seenExtIds) {
  const all = getAllMappings();
  const seen = new Set(seenExtIds);
  return all.filter((row) => !seen.has(row.ext_id));
}

function getCachedCityId(name) {
  const row = stmts.getCity.get(name);
  return row ? row.city_id : null;
}

function cacheCityId(name, cityId) {
  stmts.putCity.run(name, cityId);
}

module.exports = {
  db,
  getMapping,
  upsertMapping,
  deleteMapping,
  getAllMappings,
  getStaleMappings,
  getCachedCityId,
  cacheCityId,
};
