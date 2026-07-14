import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.GOUT_DATA_DIR || join(ROOT, 'data');
mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(
  process.env.GOUT_DB === ':memory:' ? ':memory:' : join(DATA_DIR, 'gout.db')
);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name          TEXT NOT NULL,
    pass_hash     TEXT NOT NULL,
    avatar_color  TEXT NOT NULL DEFAULT '#3d5a3c',
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash  TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at  TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS routes (
    id           INTEGER PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    sport        TEXT NOT NULL CHECK (sport IN ('wandelen','fietsen','mtb')),
    waypoints    TEXT,
    track        TEXT NOT NULL,
    distance_m   REAL NOT NULL DEFAULT 0,
    ascent_m     REAL NOT NULL DEFAULT 0,
    descent_m    REAL NOT NULL DEFAULT 0,
    duration_s   REAL NOT NULL DEFAULT 0,
    difficulty   TEXT NOT NULL DEFAULT 'gemiddeld',
    visibility   TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')),
    share_token  TEXT UNIQUE,
    start_lat    REAL,
    start_lon    REAL,
    bbox         TEXT,
    region       TEXT,
    source       TEXT NOT NULL DEFAULT 'gepland' CHECK (source IN ('gepland','geimporteerd')),
    preview      TEXT,
    gpx          TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_routes_user ON routes(user_id);
  CREATE INDEX IF NOT EXISTS idx_routes_visibility ON routes(visibility);

  CREATE TABLE IF NOT EXISTS route_likes (
    route_id   INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (route_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS activities (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    route_id    INTEGER REFERENCES routes(id) ON DELETE SET NULL,
    name        TEXT NOT NULL,
    sport       TEXT NOT NULL CHECK (sport IN ('wandelen','fietsen','mtb')),
    track       TEXT NOT NULL,
    distance_m  REAL NOT NULL DEFAULT 0,
    ascent_m    REAL NOT NULL DEFAULT 0,
    descent_m   REAL NOT NULL DEFAULT 0,
    moving_s    REAL NOT NULL DEFAULT 0,
    elapsed_s   REAL NOT NULL DEFAULT 0,
    started_at  TEXT,
    preview     TEXT,
    region      TEXT,
    gpx         TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_activities_user ON activities(user_id);
`);
