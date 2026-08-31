package legacy

import (
	"bufio"
	"crypto/sha1"
	"fmt"
	"os"
	"strconv"
	"strings"
)

type SourceAlbum struct {
	ID      string
	Ordinal int
	Title   string
	URLs    []string
}

func ParseSource(path string, visit func(SourceAlbum) error) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 2*1024*1024)
	title := ""
	urls := make([]string, 0, 128)
	coverForID := ""
	ordinal := 0
	flush := func() error {
		if title == "" || len(urls) == 0 {
			urls = urls[:0]
			return nil
		}
		album := SourceAlbum{
			ID:      sourceAlbumID(ordinal, title, coverForID),
			Ordinal: ordinal,
			Title:   title,
			URLs:    append([]string(nil), urls...),
		}
		if err := visit(album); err != nil {
			return err
		}
		ordinal++
		urls = urls[:0]
		coverForID = ""
		return nil
	}

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		if isHTTPURL(line) {
			if title != "" {
				if len(urls) == 0 {
					coverForID = line
				}
				urls = append(urls, normalizeSourceURL(line))
			}
			continue
		}
		if err := flush(); err != nil {
			return err
		}
		title = line
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	return flush()
}

func sourceAlbumID(ordinal int, title, cover string) string {
	hash := sha1.Sum([]byte(title + "\n" + cover))
	prefix := strconv.FormatInt(int64(ordinal), 36)
	if len(prefix) < 4 {
		prefix = strings.Repeat("0", 4-len(prefix)) + prefix
	}
	return fmt.Sprintf("%s-%x", prefix, hash[:5])
}

func isHTTPURL(value string) bool {
	lower := strings.ToLower(value)
	return strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://")
}

func normalizeSourceURL(value string) string {
	value = strings.Replace(value, "https://telegra.phhttps://legra.ph/file/", "https://telegra.ph/file/", 1)
	return strings.Replace(value, "https://telegra.phhttps//legra.ph/file/", "https://telegra.ph/file/", 1)
}
