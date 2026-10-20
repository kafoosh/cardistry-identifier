-- Library-wide switches set from the admin page.
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Whether uploads may add a move name that isn't in the library yet (as 'proposed').
INSERT INTO settings (key, value) VALUES ('accept_proposed_moves', '1');
