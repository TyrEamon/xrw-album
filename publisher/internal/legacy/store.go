package legacy

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

const schema = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS legacy_albums (
  album_id TEXT PRIMARY KEY,
  ordinal INTEGER NOT NULL UNIQUE,
  title TEXT NOT NULL,
  expected_count INTEGER NOT NULL,
  target_chat_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS legacy_images (
  album_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  source_url TEXT NOT NULL,
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  content_type TEXT NOT NULL DEFAULT '',
  local_path TEXT NOT NULL DEFAULT '',
  tg_url TEXT NOT NULL DEFAULT '',
  tg_file_id TEXT NOT NULL DEFAULT '',
  tg_file_unique_id TEXT NOT NULL DEFAULT '',
  tg_message_id INTEGER NOT NULL DEFAULT 0,
  tg_public_key TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  retry_count INTEGER NOT NULL DEFAULT 0,
  http_status INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (album_id, sort_order),
  FOREIGN KEY (album_id) REFERENCES legacy_albums(album_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_legacy_album_queue
  ON legacy_albums(status, next_retry_at, ordinal);
CREATE INDEX IF NOT EXISTS idx_legacy_image_status
  ON legacy_images(album_id, status, sort_order);

CREATE TABLE IF NOT EXISTS legacy_traffic (
  name TEXT PRIMARY KEY,
  bytes INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS legacy_snapshot_exports (
  album_id TEXT PRIMARY KEY,
  album_updated_at INTEGER NOT NULL,
  exported_at INTEGER NOT NULL,
  FOREIGN KEY (album_id) REFERENCES legacy_albums(album_id) ON DELETE CASCADE
);
`

type Store struct {
	db *sql.DB
}

type Album struct {
	ID           string
	Ordinal      int
	Title        string
	Expected     int
	TargetChatID string
	Status       string
}

type Image struct {
	AlbumID      string
	SortOrder    int
	SourceURL    string
	Width        int
	Height       int
	Bytes        int64
	ContentType  string
	LocalPath    string
	TGURL        string
	TGFileID     string
	TGFileUnique string
	TGMessageID  int64
	TGPublicKey  string
	Status       string
	RetryCount   int
}

type Stats struct {
	Pending, Processing, Incomplete, Ready, Invalid int
	Images, Downloaded, Uploaded, Dead              int
	SourceBytes, TelegramBytes                      int64
}

type SnapshotCandidate struct {
	AlbumID   string
	Ordinal   int
	Status    string
	UpdatedAt int64
}

func Open(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil && filepath.Dir(path) != "." {
		return nil, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("migrate legacy database: %w", err)
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) SyncSource(ctx context.Context, path string, chats []string) (int, int, error) {
	if len(chats) == 0 {
		return 0, 0, fmt.Errorf("TG_CHAT_IDS is required")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, 0, err
	}
	defer tx.Rollback()
	albumStatement, err := tx.PrepareContext(ctx, `
INSERT INTO legacy_albums
  (album_id, ordinal, title, expected_count, target_chat_id, status, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
ON CONFLICT(album_id) DO UPDATE SET
  title = excluded.title,
  expected_count = excluded.expected_count,
  updated_at = excluded.updated_at`)
	if err != nil {
		return 0, 0, err
	}
	defer albumStatement.Close()
	imageStatement, err := tx.PrepareContext(ctx, `
INSERT INTO legacy_images (album_id, sort_order, source_url, status, updated_at)
VALUES (?, ?, ?, 'pending', ?)
ON CONFLICT(album_id, sort_order) DO UPDATE SET
  source_url = excluded.source_url,
  updated_at = excluded.updated_at`)
	if err != nil {
		return 0, 0, err
	}
	defer imageStatement.Close()

	now := time.Now().Unix()
	albums, images := 0, 0
	err = ParseSource(path, func(album SourceAlbum) error {
		chat := chats[album.Ordinal%len(chats)]
		if _, err := albumStatement.ExecContext(ctx, album.ID, album.Ordinal, album.Title, len(album.URLs), chat, now, now); err != nil {
			return err
		}
		for index, sourceURL := range album.URLs {
			if _, err := imageStatement.ExecContext(ctx, album.ID, index+1, sourceURL, now); err != nil {
				return err
			}
			images++
		}
		albums++
		return nil
	})
	if err != nil {
		return 0, 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, 0, err
	}
	return albums, images, nil
}

func (s *Store) RecoverProcessing(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `
UPDATE legacy_albums SET status = 'incomplete', next_retry_at = 0, updated_at = ?
WHERE status = 'processing'`, time.Now().Unix())
	return err
}

func (s *Store) ClaimNext(ctx context.Context) (Album, bool, error) {
	row := s.db.QueryRowContext(ctx, `
UPDATE legacy_albums
SET status = 'processing', updated_at = ?
WHERE album_id = (
  SELECT album_id FROM legacy_albums
  WHERE status = 'pending' OR (status = 'incomplete' AND next_retry_at <= ?)
  ORDER BY CASE status WHEN 'incomplete' THEN 0 ELSE 1 END, ordinal
  LIMIT 1
)
RETURNING album_id, ordinal, title, expected_count, target_chat_id, status`, time.Now().Unix(), time.Now().Unix())
	var album Album
	if err := row.Scan(&album.ID, &album.Ordinal, &album.Title, &album.Expected, &album.TargetChatID, &album.Status); err != nil {
		if err == sql.ErrNoRows {
			return Album{}, false, nil
		}
		return Album{}, false, err
	}
	return album, true, nil
}

func (s *Store) Images(ctx context.Context, albumID string) ([]Image, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT album_id, sort_order, source_url, width, height, bytes, content_type, local_path,
       tg_url, tg_file_id, tg_file_unique_id, tg_message_id, tg_public_key, status, retry_count
FROM legacy_images WHERE album_id = ? ORDER BY sort_order`, albumID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []Image
	for rows.Next() {
		var item Image
		if err := rows.Scan(&item.AlbumID, &item.SortOrder, &item.SourceURL, &item.Width, &item.Height,
			&item.Bytes, &item.ContentType, &item.LocalPath, &item.TGURL, &item.TGFileID,
			&item.TGFileUnique, &item.TGMessageID, &item.TGPublicKey, &item.Status, &item.RetryCount); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (s *Store) MarkDownloaded(ctx context.Context, item Image) error {
	_, err := s.db.ExecContext(ctx, `
UPDATE legacy_images SET width = ?, height = ?, bytes = ?, content_type = ?, local_path = ?,
  status = 'downloaded', last_error = '', http_status = 200, updated_at = ?
WHERE album_id = ? AND sort_order = ?`, item.Width, item.Height, item.Bytes, item.ContentType,
		item.LocalPath, time.Now().Unix(), item.AlbumID, item.SortOrder)
	return err
}

func (s *Store) MarkSourceFailure(ctx context.Context, albumID string, order, httpStatus, maxRetries int, message string, retryDelay time.Duration) (bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	var retries int
	if err := tx.QueryRowContext(ctx, `
UPDATE legacy_images SET retry_count = retry_count + 1, http_status = ?, last_error = ?, updated_at = ?
WHERE album_id = ? AND sort_order = ? RETURNING retry_count`, httpStatus, message, time.Now().Unix(), albumID, order).Scan(&retries); err != nil {
		return false, err
	}
	invalid := retries >= maxRetries
	imageStatus, albumStatus := "pending", "incomplete"
	if invalid {
		imageStatus, albumStatus = "dead", "invalid"
	}
	if _, err := tx.ExecContext(ctx, `UPDATE legacy_images SET status = ?, updated_at = ? WHERE album_id = ? AND sort_order = ?`, imageStatus, time.Now().Unix(), albumID, order); err != nil {
		return false, err
	}
	nextRetry := time.Now().Add(retryDelay).Unix()
	if invalid {
		nextRetry = 0
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE legacy_albums SET status = ?, retry_count = retry_count + 1, next_retry_at = ?, last_error = ?, updated_at = ?
WHERE album_id = ?`, albumStatus, nextRetry, message, time.Now().Unix(), albumID); err != nil {
		return false, err
	}
	return invalid, tx.Commit()
}

func (s *Store) MarkUploadFailure(ctx context.Context, albumID, message string, retryDelay time.Duration) error {
	_, err := s.db.ExecContext(ctx, `
UPDATE legacy_albums SET status = 'incomplete', next_retry_at = ?, last_error = ?, updated_at = ?
WHERE album_id = ?`, time.Now().Add(retryDelay).Unix(), message, time.Now().Unix(), albumID)
	return err
}

func (s *Store) MarkUploaded(ctx context.Context, items []Image) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, item := range items {
		if _, err := tx.ExecContext(ctx, `
UPDATE legacy_images SET tg_url = ?, tg_file_id = ?, tg_file_unique_id = ?, tg_message_id = ?,
  tg_public_key = ?, status = 'uploaded', last_error = '', updated_at = ?
WHERE album_id = ? AND sort_order = ?`, item.TGURL, item.TGFileID, item.TGFileUnique,
			item.TGMessageID, item.TGPublicKey, time.Now().Unix(), item.AlbumID, item.SortOrder); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) MarkReady(ctx context.Context, albumID string) error {
	_, err := s.db.ExecContext(ctx, `
UPDATE legacy_albums SET status = 'ready', retry_count = 0, next_retry_at = 0,
  last_error = '', updated_at = ? WHERE album_id = ?`, time.Now().Unix(), albumID)
	return err
}

func (s *Store) PendingSnapshots(ctx context.Context, limit int) ([]SnapshotCandidate, error) {
	if limit < 1 {
		return nil, fmt.Errorf("snapshot limit must be positive")
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT a.album_id, a.ordinal, a.status, a.updated_at
FROM legacy_albums a
LEFT JOIN legacy_snapshot_exports e ON e.album_id = a.album_id
WHERE a.status IN ('ready', 'invalid')
  AND (e.album_id IS NULL OR e.album_updated_at <> a.updated_at)
ORDER BY a.updated_at, a.ordinal
LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var candidates []SnapshotCandidate
	for rows.Next() {
		var candidate SnapshotCandidate
		if err := rows.Scan(&candidate.AlbumID, &candidate.Ordinal, &candidate.Status, &candidate.UpdatedAt); err != nil {
			return nil, err
		}
		candidates = append(candidates, candidate)
	}
	return candidates, rows.Err()
}

func (s *Store) SnapshotAlbum(ctx context.Context, albumID string) (Album, []Image, error) {
	var album Album
	err := s.db.QueryRowContext(ctx, `
SELECT album_id, ordinal, title, expected_count, target_chat_id, status
FROM legacy_albums WHERE album_id = ?`, albumID).Scan(
		&album.ID, &album.Ordinal, &album.Title, &album.Expected, &album.TargetChatID, &album.Status,
	)
	if err != nil {
		return Album{}, nil, err
	}
	images, err := s.Images(ctx, albumID)
	return album, images, err
}

func (s *Store) MarkSnapshotsExported(ctx context.Context, candidates []SnapshotCandidate) error {
	if len(candidates) == 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := time.Now().Unix()
	for _, candidate := range candidates {
		if _, err := tx.ExecContext(ctx, `
INSERT INTO legacy_snapshot_exports (album_id, album_updated_at, exported_at)
VALUES (?, ?, ?)
ON CONFLICT(album_id) DO UPDATE SET
  album_updated_at = excluded.album_updated_at,
  exported_at = excluded.exported_at`, candidate.AlbumID, candidate.UpdatedAt, now); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) AddTraffic(ctx context.Context, name string, bytes int64) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO legacy_traffic(name, bytes) VALUES (?, ?)
ON CONFLICT(name) DO UPDATE SET bytes = bytes + excluded.bytes`, name, bytes)
	return err
}

func (s *Store) Stats(ctx context.Context) (Stats, error) {
	var stats Stats
	rows, err := s.db.QueryContext(ctx, `SELECT status, COUNT(*) FROM legacy_albums GROUP BY status`)
	if err != nil {
		return stats, err
	}
	for rows.Next() {
		var status string
		var count int
		if err := rows.Scan(&status, &count); err != nil {
			rows.Close()
			return stats, err
		}
		switch status {
		case "pending":
			stats.Pending = count
		case "processing":
			stats.Processing = count
		case "incomplete":
			stats.Incomplete = count
		case "ready":
			stats.Ready = count
		case "invalid":
			stats.Invalid = count
		}
	}
	if err := rows.Close(); err != nil {
		return stats, err
	}
	rows, err = s.db.QueryContext(ctx, `SELECT status, COUNT(*) FROM legacy_images GROUP BY status`)
	if err != nil {
		return stats, err
	}
	for rows.Next() {
		var status string
		var count int
		if err := rows.Scan(&status, &count); err != nil {
			rows.Close()
			return stats, err
		}
		stats.Images += count
		switch status {
		case "downloaded":
			stats.Downloaded = count
		case "uploaded":
			stats.Uploaded = count
		case "dead":
			stats.Dead = count
		}
	}
	if err := rows.Close(); err != nil {
		return stats, err
	}
	_ = s.db.QueryRowContext(ctx, `SELECT COALESCE(bytes, 0) FROM legacy_traffic WHERE name = 'source_image_bytes'`).Scan(&stats.SourceBytes)
	_ = s.db.QueryRowContext(ctx, `SELECT COALESCE(bytes, 0) FROM legacy_traffic WHERE name = 'telegram_file_bytes'`).Scan(&stats.TelegramBytes)
	return stats, nil
}

func (s *Store) InvalidReport(ctx context.Context, path string) (int, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT a.album_id, a.ordinal, a.title, a.expected_count, a.last_error,
       i.sort_order, i.source_url, i.http_status, i.last_error
FROM legacy_albums a
JOIN legacy_images i ON i.album_id = a.album_id AND i.status = 'dead'
WHERE a.status = 'invalid'
ORDER BY a.ordinal, i.sort_order`)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	type invalidImage struct {
		Order      int    `json:"order"`
		URL        string `json:"url"`
		HTTPStatus int    `json:"http_status,omitempty"`
		Error      string `json:"error"`
	}
	type invalidAlbum struct {
		ID       string         `json:"id"`
		Ordinal  int            `json:"ordinal"`
		Title    string         `json:"title"`
		Count    int            `json:"count"`
		Error    string         `json:"error"`
		Failures []invalidImage `json:"failures"`
	}
	var result []invalidAlbum
	index := make(map[string]int)
	for rows.Next() {
		var id, title, albumError, sourceURL, imageError string
		var ordinal, count, order, status int
		if err := rows.Scan(&id, &ordinal, &title, &count, &albumError, &order, &sourceURL, &status, &imageError); err != nil {
			return 0, err
		}
		position, found := index[id]
		if !found {
			position = len(result)
			index[id] = position
			result = append(result, invalidAlbum{ID: id, Ordinal: ordinal, Title: title, Count: count, Error: albumError})
		}
		result[position].Failures = append(result[position].Failures, invalidImage{Order: order, URL: sourceURL, HTTPStatus: status, Error: imageError})
	}
	data, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		return 0, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil && filepath.Dir(path) != "." {
		return 0, err
	}
	return len(result), os.WriteFile(path, append(data, '\n'), 0o644)
}
