CREATE TABLE source_roots (source_path TEXT NOT NULL, scan_root TEXT NOT NULL, seen_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY(source_path, scan_root));
