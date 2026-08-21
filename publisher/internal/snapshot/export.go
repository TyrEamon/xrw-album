package snapshot

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/TyrEamon/xrw-album/publisher/internal/model"
	"github.com/TyrEamon/xrw-album/publisher/internal/store"
)

type Batch struct {
	Version    int                    `json:"version"`
	ExportedAt string                 `json:"exported_at"`
	Galleries  []model.PublishPayload `json:"galleries"`
}

func Export(ctx context.Context, database *store.Store, outDir string, limit int) (string, int, error) {
	candidates, err := database.PendingSnapshots(ctx, limit)
	if err != nil || len(candidates) == 0 {
		return "", 0, err
	}

	payloads := make([]model.PublishPayload, 0, len(candidates))
	for _, candidate := range candidates {
		payload, err := database.Payload(ctx, candidate.GalleryID, candidate.ChannelID)
		if err != nil {
			return "", 0, fmt.Errorf("snapshot gallery %d: %w", candidate.GalleryID, err)
		}
		payload.TGFiles = nil
		payloads = append(payloads, payload)
	}

	now := time.Now().UTC()
	batch := Batch{Version: 1, ExportedAt: now.Format(time.RFC3339), Galleries: payloads}
	encoded, err := json.Marshal(batch)
	if err != nil {
		return "", 0, err
	}
	if err := os.MkdirAll(outDir, 0755); err != nil {
		return "", 0, err
	}
	name := fmt.Sprintf("snapshot-%s-%d-%d.json", now.Format("20060102T150405.000000000Z"), candidates[0].GalleryID, candidates[len(candidates)-1].GalleryID)
	target := filepath.Join(outDir, name)
	temporary, err := os.CreateTemp(outDir, ".snapshot-*.tmp")
	if err != nil {
		return "", 0, err
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if _, err := temporary.Write(encoded); err != nil {
		temporary.Close()
		return "", 0, err
	}
	if err := temporary.Close(); err != nil {
		return "", 0, err
	}
	if err := os.Rename(temporaryName, target); err != nil {
		return "", 0, err
	}
	if err := database.MarkSnapshotsExported(ctx, candidates); err != nil {
		return "", 0, err
	}
	return target, len(payloads), nil
}
