-- Hash of each recording's landmark data, so the same recording is never stored twice.
ALTER TABLE recordings ADD COLUMN content_hash TEXT;
CREATE UNIQUE INDEX recordings_content_hash ON recordings(content_hash);
