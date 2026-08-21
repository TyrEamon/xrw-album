ALTER TABLE albums ADD COLUMN category TEXT NOT NULL DEFAULT '';
ALTER TABLE albums ADD COLUMN source TEXT NOT NULL DEFAULT 'linuxdo-85w';
ALTER TABLE albums ADD COLUMN source_gallery_id TEXT NOT NULL DEFAULT '';
ALTER TABLE albums ADD COLUMN source_updated_at TEXT NOT NULL DEFAULT '';
ALTER TABLE albums ADD COLUMN publish_status TEXT NOT NULL DEFAULT 'ok';
ALTER TABLE albums ADD COLUMN storage_provider TEXT NOT NULL DEFAULT 'telegraph';
ALTER TABLE albums ADD COLUMN mirror_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE albums ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;

UPDATE albums
SET source_gallery_id = id
WHERE source_gallery_id = '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_albums_source_gallery
  ON albums(source, source_gallery_id)
  WHERE source_gallery_id <> '';
CREATE INDEX IF NOT EXISTS idx_albums_publish_order
  ON albums(publish_status, album_order);

CREATE TABLE IF NOT EXISTS album_sources (
  source TEXT NOT NULL,
  source_gallery_id TEXT NOT NULL,
  album_id TEXT NOT NULL,
  source_updated_at TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source, source_gallery_id),
  FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE CASCADE
);

INSERT INTO album_sources (source, source_gallery_id, album_id, source_updated_at, updated_at)
SELECT source, source_gallery_id, id, source_updated_at, updated_at
FROM albums
WHERE source_gallery_id <> ''
ON CONFLICT(source, source_gallery_id) DO UPDATE SET
  album_id = excluded.album_id,
  source_updated_at = excluded.source_updated_at,
  updated_at = excluded.updated_at;

CREATE TABLE IF NOT EXISTS tg_files (
  public_key TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  file_unique_id TEXT NOT NULL DEFAULT '',
  message_id INTEGER NOT NULL DEFAULT 0,
  content_type TEXT NOT NULL DEFAULT 'image/jpeg',
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  name TEXT NOT NULL,
  name_lc TEXT NOT NULL,
  gallery_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  UNIQUE(source, name)
);

CREATE INDEX IF NOT EXISTS idx_tags_name_lc
  ON tags(name_lc);

CREATE TABLE IF NOT EXISTS album_tags (
  album_id TEXT NOT NULL,
  tag_id INTEGER NOT NULL,
  PRIMARY KEY (album_id, tag_id),
  FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_album_tags_tag
  ON album_tags(tag_id, album_id);

CREATE TRIGGER IF NOT EXISTS trg_album_tags_insert
AFTER INSERT ON album_tags
BEGIN
  UPDATE tags SET gallery_count = gallery_count + 1 WHERE id = NEW.tag_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_album_tags_delete
AFTER DELETE ON album_tags
BEGIN
  UPDATE tags SET gallery_count = MAX(0, gallery_count - 1) WHERE id = OLD.tag_id;
END;
