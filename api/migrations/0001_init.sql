-- Shared library schema (see docs/build-plan.md, section 3).
-- Sequence files live in recording_data (D1 blob) rather than R2: R2 needs a
-- payment card on the Cloudflare account, and a gzipped recording is ~20 KB,
-- so D1's free 5 GB holds a few hundred thousand.

CREATE TABLE moves (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  aliases     TEXT NOT NULL DEFAULT '[]',
  category    TEXT,
  description TEXT,
  credited_to TEXT,
  status      TEXT NOT NULL DEFAULT 'proposed', -- proposed, approved, merged
  merged_into TEXT,
  created_by  TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE recordings (
  id            TEXT PRIMARY KEY,
  move_id       TEXT NOT NULL REFERENCES moves(id),
  device_id     TEXT NOT NULL,
  delete_hash   TEXT NOT NULL,
  nickname      TEXT,
  fps           REAL NOT NULL,
  frame_count   INTEGER NOT NULL,
  duration_ms   INTEGER NOT NULL,
  handedness    TEXT,              -- left-dominant / right-dominant
  camera_view   TEXT,              -- front, top-down, side
  camera        TEXT,              -- user, environment
  device        TEXT,
  width         INTEGER,
  height        INTEGER,
  quality_score REAL NOT NULL,
  longest_gap_ms INTEGER,
  data_bytes    INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending', -- pending, approved, rejected
  created_at    INTEGER NOT NULL
);
CREATE INDEX recordings_move ON recordings(move_id, status, created_at);
CREATE INDEX recordings_device ON recordings(device_id);

CREATE TABLE recording_data (
  recording_id TEXT PRIMARY KEY REFERENCES recordings(id) ON DELETE CASCADE,
  gz           BLOB NOT NULL       -- gzipped JSON sequence file
);

CREATE TABLE votes (
  recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  device_id    TEXT NOT NULL,
  ip_hash      TEXT,
  vote         INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (recording_id, device_id)
);

CREATE TABLE reports (
  id          TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,        -- move, recording
  target_id   TEXT NOT NULL,
  reason      TEXT,
  device_id   TEXT,
  resolved    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

-- Daily write counters per device and per IP (hashed).
CREATE TABLE rate_limits (
  key   TEXT NOT NULL,
  day   TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, day)
);

INSERT INTO moves (id, name, slug, category, status, created_by, created_at) VALUES
  ('move-charlier-cut',   'Charlier cut',   'charlier-cut',   'cut',  'approved', 'seed', 0),
  ('move-revolution-cut', 'Revolution cut', 'revolution-cut', 'cut',  'approved', 'seed', 0),
  ('move-swing-cut',      'Swing cut',      'swing-cut',      'cut',  'approved', 'seed', 0),
  ('move-l-cuts',         'L cuts',         'l-cuts',         'cut',  'approved', 'seed', 0),
  ('move-sybil',          'Sybil',          'sybil',          'cut',  'approved', 'seed', 0),
  ('move-spring',         'Spring',         'spring',         'flourish', 'approved', 'seed', 0),
  ('move-molecule-spin',  'Molecule spin',  'molecule-spin',  'flourish', 'approved', 'seed', 0);
