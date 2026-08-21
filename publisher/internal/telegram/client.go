package telegram

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const maxMediaGroupSize = 10

type Client struct {
	apiBase        string
	botToken       string
	publicBase     string
	client         *http.Client
	interval       time.Duration
	globalInterval time.Duration
	concurrent     chan struct{}
	mu             sync.Mutex
	nextByChat     map[string]time.Time
	globalNext     time.Time
}

type UploadItem struct {
	Path        string
	ContentType string
	PublicKey   string
}

type Result struct {
	URL          string
	FileID       string
	FileUniqueID string
	MessageID    int64
	PublicKey    string
	ContentType  string
}

type botEnvelope struct {
	OK          bool            `json:"ok"`
	Description string          `json:"description"`
	Result      json.RawMessage `json:"result"`
}

type botMessage struct {
	MessageID int64 `json:"message_id"`
	Document  struct {
		FileID       string `json:"file_id"`
		FileUniqueID string `json:"file_unique_id"`
		MimeType     string `json:"mime_type"`
	} `json:"document"`
}

type inputMedia struct {
	Type      string `json:"type"`
	Media     string `json:"media"`
	Caption   string `json:"caption,omitempty"`
	ParseMode string `json:"parse_mode,omitempty"`
}

func New(apiBase, botToken, publicBase string, interval, globalInterval time.Duration, maxConcurrent int, timeout time.Duration) *Client {
	return &Client{
		apiBase: strings.TrimRight(apiBase, "/"), botToken: botToken,
		publicBase: strings.TrimRight(publicBase, "/"), client: &http.Client{Timeout: timeout},
		interval: interval, globalInterval: globalInterval,
		concurrent: make(chan struct{}, maxConcurrent), nextByChat: make(map[string]time.Time),
	}
}

func (c *Client) Enabled() bool {
	return c != nil && c.botToken != "" && c.publicBase != ""
}

// UploadGroup publishes one document or a Telegram media group of 2-10 documents.
// Caption is attached only to the first document in the request.
func (c *Client) UploadGroup(ctx context.Context, chatID string, items []UploadItem, caption string) ([]Result, error) {
	if !c.Enabled() {
		return nil, fmt.Errorf("TG_BOT_TOKEN and IMAGE_PUBLIC_BASE are required")
	}
	if strings.TrimSpace(chatID) == "" {
		return nil, fmt.Errorf("Telegram chat id is required")
	}
	if len(items) == 0 || len(items) > maxMediaGroupSize {
		return nil, fmt.Errorf("Telegram document upload must contain 1-%d items", maxMediaGroupSize)
	}
	if err := c.wait(ctx, chatID); err != nil {
		return nil, err
	}
	select {
	case c.concurrent <- struct{}{}:
		defer func() { <-c.concurrent }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}

	pipeReader, pipeWriter := io.Pipe()
	writer := multipart.NewWriter(pipeWriter)
	endpointMethod := "sendMediaGroup"
	if len(items) == 1 {
		endpointMethod = "sendDocument"
	}
	endpoint := c.apiBase + "/bot" + c.botToken + "/" + endpointMethod
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, pipeReader)
	if err != nil {
		_ = pipeReader.Close()
		_ = pipeWriter.Close()
		return nil, err
	}
	request.Header.Set("Content-Type", writer.FormDataContentType())
	request.Header.Set("Accept", "application/json")

	go func() {
		err := writeUploadForm(writer, chatID, items, caption)
		if err == nil {
			err = writer.Close()
		}
		_ = pipeWriter.CloseWithError(err)
	}()

	response, err := c.client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	var envelope botEnvelope
	if err := json.Unmarshal(data, &envelope); err != nil {
		return nil, fmt.Errorf("decode Telegram response: %w", err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 || !envelope.OK {
		return nil, fmt.Errorf("Telegram Bot API HTTP %d: %s", response.StatusCode, envelope.Description)
	}

	messages := make([]botMessage, 0, len(items))
	if len(items) == 1 {
		var message botMessage
		if err := json.Unmarshal(envelope.Result, &message); err != nil {
			return nil, fmt.Errorf("decode Telegram document response: %w", err)
		}
		messages = append(messages, message)
	} else if err := json.Unmarshal(envelope.Result, &messages); err != nil {
		return nil, fmt.Errorf("decode Telegram media group response: %w", err)
	}
	if len(messages) != len(items) {
		return nil, fmt.Errorf("Telegram returned %d messages for %d documents", len(messages), len(items))
	}

	results := make([]Result, len(items))
	for index, message := range messages {
		fileID, uniqueID, contentType := documentMedia(message, items[index].ContentType)
		if fileID == "" {
			return nil, fmt.Errorf("Telegram response item %d has no document file_id", index+1)
		}
		results[index] = Result{
			URL:          c.publicBase + "/file/" + url.PathEscape(items[index].PublicKey),
			FileID:       fileID,
			FileUniqueID: uniqueID,
			MessageID:    message.MessageID,
			PublicKey:    items[index].PublicKey,
			ContentType:  contentType,
		}
	}
	return results, nil
}

func writeUploadForm(writer *multipart.Writer, chatID string, items []UploadItem, caption string) error {
	if err := writer.WriteField("chat_id", chatID); err != nil {
		return err
	}
	if len(items) == 1 {
		if caption != "" {
			if err := writer.WriteField("caption", caption); err != nil {
				return err
			}
			if err := writer.WriteField("parse_mode", "HTML"); err != nil {
				return err
			}
		}
		if err := writer.WriteField("disable_content_type_detection", "false"); err != nil {
			return err
		}
		return writeFilePart(writer, "document", items[0])
	}

	media := make([]inputMedia, len(items))
	for index := range items {
		media[index] = inputMedia{Type: "document", Media: fmt.Sprintf("attach://document%d", index)}
	}
	if caption != "" {
		media[0].Caption = caption
		media[0].ParseMode = "HTML"
	}
	encoded, err := json.Marshal(media)
	if err != nil {
		return err
	}
	if err := writer.WriteField("media", string(encoded)); err != nil {
		return err
	}
	for index, item := range items {
		if err := writeFilePart(writer, fmt.Sprintf("document%d", index), item); err != nil {
			return err
		}
	}
	return nil
}

func writeFilePart(writer *multipart.Writer, fieldName string, item UploadItem) error {
	file, err := os.Open(item.Path)
	if err != nil {
		return err
	}
	defer file.Close()
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", mime.FormatMediaType("form-data", map[string]string{
		"name": fieldName, "filename": filepath.Base(item.Path),
	}))
	header.Set("Content-Type", item.ContentType)
	part, err := writer.CreatePart(header)
	if err != nil {
		return err
	}
	_, err = io.Copy(part, file)
	return err
}

func documentMedia(message botMessage, fallbackContentType string) (string, string, string) {
	contentType := message.Document.MimeType
	if contentType == "" {
		contentType = fallbackContentType
	}
	return message.Document.FileID, message.Document.FileUniqueID, contentType
}

func (c *Client) wait(ctx context.Context, chatID string) error {
	c.mu.Lock()
	readyAt := c.nextByChat[chatID]
	if c.globalNext.After(readyAt) {
		readyAt = c.globalNext
	}
	if readyAt.Before(time.Now()) {
		readyAt = time.Now()
	}
	c.nextByChat[chatID] = readyAt.Add(c.interval)
	c.globalNext = readyAt.Add(c.globalInterval)
	c.mu.Unlock()

	timer := time.NewTimer(time.Until(readyAt))
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
