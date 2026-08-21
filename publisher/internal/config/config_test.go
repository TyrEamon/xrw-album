package config

import "testing"

func TestChatForGalleryIsStable(t *testing.T) {
	cfg := Config{TGChatIDs: []string{"channel-0", "channel-1", "channel-2"}}
	if got := cfg.ChatForGallery(7); got != "channel-1" {
		t.Fatalf("gallery 7 assigned to %q", got)
	}
	if got := cfg.ChatForGallery(7); got != "channel-1" {
		t.Fatalf("gallery assignment changed to %q", got)
	}
}

func TestChatForGalleryWithoutChannels(t *testing.T) {
	if got := (Config{}).ChatForGallery(7); got != "" {
		t.Fatalf("unexpected channel %q", got)
	}
}
