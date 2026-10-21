-- The library's prebuilt matching model (src/recognition/model.ts), uploaded
-- gzipped by the build-model workflow. One row: the current model.
CREATE TABLE models (
  id         TEXT PRIMARY KEY,
  version    TEXT NOT NULL,
  gz         BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
