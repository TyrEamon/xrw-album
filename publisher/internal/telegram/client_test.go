package telegram

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestUploadDocumentGroup(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/botsecret/sendMediaGroup" {
			http.NotFound(response, request)
			return
		}
		if err := request.ParseMultipartForm(1 << 20); err != nil {
			t.Fatal(err)
		}
		if request.FormValue("chat_id") != "-100123" {
			t.Fatalf("unexpected chat_id %q", request.FormValue("chat_id"))
		}
		var media []inputMedia
		if err := json.Unmarshal([]byte(request.FormValue("media")), &media); err != nil {
			t.Fatal(err)
		}
		if len(media) != 2 || media[0].Type != "document" ||
			media[0].Caption != "#tag\n<blockquote>album</blockquote>" || media[1].Caption != "" {
			t.Fatalf("unexpected media: %+v", media)
		}
		for index := range media {
			file, _, err := request.FormFile(fmt.Sprintf("document%d", index))
			if err != nil {
				t.Fatal(err)
			}
			data, _ := io.ReadAll(file)
			_ = file.Close()
			if string(data) != fmt.Sprintf("image-%d", index) {
				t.Fatalf("unexpected body %q", data)
			}
		}
		response.Header().Set("Content-Type", "application/json")
		fmt.Fprint(response, "{\"ok\":true,\"result\":[{\"message_id\":41,\"document\":{\"file_id\":\"file-1\",\"file_unique_id\":\"unique-1\",\"mime_type\":\"image/png\"}},{\"message_id\":42,\"document\":{\"file_id\":\"file-2\",\"file_unique_id\":\"unique-2\",\"mime_type\":\"image/png\"}}]}")
	}))
	defer server.Close()

	directory := t.TempDir()
	items := make([]UploadItem, 2)
	for index := range items {
		path := filepath.Join(directory, fmt.Sprintf("test-%d.png", index))
		if err := os.WriteFile(path, []byte(fmt.Sprintf("image-%d", index)), 0o644); err != nil {
			t.Fatal(err)
		}
		items[index] = UploadItem{Path: path, ContentType: "image/png", PublicKey: fmt.Sprintf("veil-%d", index)}
	}
	client := New(server.URL, "secret", "https://img.example", 0, 0, 1, time.Second)
	results, err := client.UploadGroup(context.Background(), "-100123", items, "#tag\n<blockquote>album</blockquote>")
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 2 || results[0].URL != "https://img.example/file/veil-0" ||
		results[0].FileID != "file-1" || results[1].MessageID != 42 || results[0].ContentType != "image/png" {
		t.Fatalf("unexpected results: %+v", results)
	}
}

func TestUploadSingleDocument(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/botsecret/sendDocument" {
			http.NotFound(response, request)
			return
		}
		if err := request.ParseMultipartForm(1 << 20); err != nil {
			t.Fatal(err)
		}
		if request.FormValue("parse_mode") != "HTML" ||
			request.FormValue("caption") != "<blockquote>one</blockquote>" {
			t.Fatalf("unexpected caption fields")
		}
		if _, _, err := request.FormFile("document"); err != nil {
			t.Fatal(err)
		}
		response.Header().Set("Content-Type", "application/json")
		fmt.Fprint(response, "{\"ok\":true,\"result\":{\"message_id\":7,\"document\":{\"file_id\":\"file-7\",\"file_unique_id\":\"unique-7\",\"mime_type\":\"image/jpeg\"}}}")
	}))
	defer server.Close()

	path := filepath.Join(t.TempDir(), "one.jpg")
	if err := os.WriteFile(path, []byte("document"), 0o644); err != nil {
		t.Fatal(err)
	}
	client := New(server.URL, "secret", "https://img.example", 0, 0, 1, time.Second)
	results, err := client.UploadGroup(context.Background(), "-100456", []UploadItem{{
		Path: path, ContentType: "image/jpeg", PublicKey: "veil-1",
	}}, "<blockquote>one</blockquote>")
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].FileID != "file-7" ||
		results[0].FileUniqueID != "unique-7" || results[0].ContentType != "image/jpeg" {
		t.Fatalf("unexpected result: %+v", results)
	}
}
