package store_test

import (
	"database/sql"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"

	_ "modernc.org/sqlite"
)

func TestD1MigrationsApplyInOrder(t *testing.T) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test location")
	}
	repositoryRoot := filepath.Clean(filepath.Join(filepath.Dir(currentFile), "..", "..", ".."))
	database, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "d1.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()

	for _, name := range []string{"0001_init.sql", "0002_publishing.sql"} {
		contents, err := os.ReadFile(filepath.Join(repositoryRoot, "migrations", name))
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		if _, err := database.Exec(string(contents)); err != nil {
			t.Fatalf("apply %s: %v", name, err)
		}
	}

	for _, object := range []struct {
		name string
		kind string
	}{
		{"album_sources", "table"},
		{"tg_files", "table"},
		{"tags", "table"},
		{"album_tags", "table"},
		{"trg_album_tags_insert", "trigger"},
		{"trg_album_tags_delete", "trigger"},
	} {
		var found int
		if err := database.QueryRow(
			"SELECT COUNT(*) FROM sqlite_master WHERE name = ? AND type = ?",
			object.name, object.kind,
		).Scan(&found); err != nil {
			t.Fatal(err)
		}
		if found != 1 {
			t.Fatalf("missing %s %s", object.kind, object.name)
		}
	}
}

func TestD1SeedExportPreservesPublishedRows(t *testing.T) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test location")
	}
	repositoryRoot := filepath.Clean(filepath.Join(filepath.Dir(currentFile), "..", "..", ".."))
	databasePath := filepath.Join(t.TempDir(), "seed.db")
	database, err := sql.Open("sqlite", databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	for _, name := range []string{"0001_init.sql", "0002_publishing.sql"} {
		contents, err := os.ReadFile(filepath.Join(repositoryRoot, "migrations", name))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := database.Exec(string(contents)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := database.Exec(`
INSERT INTO albums (id, title, title_lc, count, cover, href, album_order, start_offset, end_offset,
  source, source_gallery_id, publish_status, storage_provider, mirror_status)
VALUES ('veil-1', 'dynamic', 'dynamic', 1, 'https://example.test/file/1',
  'https://example.test/gallery/1', 99, 100, 101, 'veil', '1', 'ok', 'telegram', 'ok')
`); err != nil {
		t.Fatal(err)
	}

	seedPath := filepath.Join(t.TempDir(), "seed.sql")
	command := exec.Command("node", filepath.Join(repositoryRoot, "scripts", "export-d1-sql.js"),
		"--limit=2", "--out="+seedPath)
	command.Dir = repositoryRoot
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("export seed: %v\n%s", err, output)
	}
	seed, err := os.ReadFile(seedPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(string(seed)); err != nil {
		t.Fatalf("apply generated seed: %v", err)
	}

	var albumCount, manifestCount, photoCount int
	if err := database.QueryRow("SELECT COUNT(*) FROM albums").Scan(&albumCount); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`
SELECT json_extract(value, '$.albumCount'), json_extract(value, '$.photoCount')
FROM meta WHERE key = 'manifest'
`).Scan(&manifestCount, &photoCount); err != nil {
		t.Fatal(err)
	}
	if albumCount != 3 || manifestCount != 3 || photoCount != 65 {
		t.Fatalf("unexpected counts: albums=%d manifest=%d photos=%d", albumCount, manifestCount, photoCount)
	}
}
