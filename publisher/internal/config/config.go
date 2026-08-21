package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	VeilBaseURL       string
	VeilProxies       []string
	VeilRequests      int
	VeilWindow        time.Duration
	VeilCooldown      time.Duration
	DatabasePath      string
	WorkDir           string
	TGBotToken        string
	TGChatIDs         []string
	TGAPIBase         string
	ImagePublicBase   string
	GitHubImageBase   string
	GitHubImageSecret string
	TGUploadInterval  time.Duration
	TGGlobalInterval  time.Duration
	TGMaxConcurrent   int
	AdminURL          string
	AdminToken        string
	DiscoveryInterval time.Duration
	GalleryWorkers    int
	GalleryMaxRetries int
	HTTPTimeout       time.Duration
	MaxImageBytes     int64
}

func Load() (Config, error) {
	cfg := Config{
		VeilBaseURL:       env("VEIL_BASE_URL", "https://veil.ortlinde.com"),
		VeilProxies:       csv(os.Getenv("VEIL_PROXIES")),
		VeilRequests:      envInt("VEIL_REQUESTS_PER_WINDOW", 80),
		VeilWindow:        envDuration("VEIL_WINDOW", 300*time.Second),
		VeilCooldown:      envDuration("VEIL_COOLDOWN", 35*time.Minute),
		DatabasePath:      env("PUBLISHER_DB", "publisher.db"),
		WorkDir:           env("PUBLISHER_WORK_DIR", "work"),
		TGBotToken:        strings.TrimSpace(os.Getenv("TG_BOT_TOKEN")),
		TGChatIDs:         telegramChats(),
		TGAPIBase:         strings.TrimRight(env("TG_API_BASE", "https://api.telegram.org"), "/"),
		ImagePublicBase:   strings.TrimRight(strings.TrimSpace(os.Getenv("IMAGE_PUBLIC_BASE")), "/"),
		GitHubImageBase:   strings.TrimRight(strings.TrimSpace(os.Getenv("GIMG_PUBLIC_BASE")), "/"),
		GitHubImageSecret: strings.TrimSpace(os.Getenv("GIMG_SIGNING_SECRET")),
		TGUploadInterval:  envDuration("TG_UPLOAD_INTERVAL", 3500*time.Millisecond),
		TGGlobalInterval:  envDuration("TG_GLOBAL_INTERVAL", 500*time.Millisecond),
		TGMaxConcurrent:   envInt("TG_MAX_CONCURRENT", 3),
		AdminURL:          strings.TrimRight(strings.TrimSpace(os.Getenv("XRW_ADMIN_URL")), "/"),
		AdminToken:        os.Getenv("XRW_ADMIN_TOKEN"),
		DiscoveryInterval: envDuration("DISCOVERY_INTERVAL", 15*time.Minute),
		GalleryWorkers:    envInt("GALLERY_WORKERS", 2),
		GalleryMaxRetries: envInt("GALLERY_MAX_RETRIES", 5),
		HTTPTimeout:       envDuration("HTTP_TIMEOUT", 2*time.Minute),
		MaxImageBytes:     int64(envInt("MAX_IMAGE_MB", 20)) * 1024 * 1024,
	}

	if cfg.VeilRequests < 1 {
		return Config{}, fmt.Errorf("VEIL_REQUESTS_PER_WINDOW must be positive")
	}
	if cfg.GalleryWorkers < 1 {
		return Config{}, fmt.Errorf("GALLERY_WORKERS must be positive")
	}
	if cfg.GalleryMaxRetries < 1 {
		return Config{}, fmt.Errorf("GALLERY_MAX_RETRIES must be positive")
	}
	if cfg.TGMaxConcurrent < 1 {
		return Config{}, fmt.Errorf("TG_MAX_CONCURRENT must be positive")
	}
	if cfg.MaxImageBytes < 1 {
		return Config{}, fmt.Errorf("MAX_IMAGE_MB must be positive")
	}
	if cfg.MaxImageBytes > 20*1024*1024 {
		return Config{}, fmt.Errorf("MAX_IMAGE_MB cannot exceed Telegram Bot API's 20 MB download limit")
	}
	if cfg.AdminURL != "" && cfg.AdminToken == "" {
		return Config{}, fmt.Errorf("XRW_ADMIN_TOKEN is required when XRW_ADMIN_URL is set")
	}
	return cfg, nil
}

func (c Config) ChatForGallery(galleryID int64) string {
	if len(c.TGChatIDs) == 0 {
		return ""
	}
	if galleryID < 0 {
		galleryID = -galleryID
	}
	return c.TGChatIDs[galleryID%int64(len(c.TGChatIDs))]
}

func telegramChats() []string {
	if chats := csv(os.Getenv("TG_CHAT_IDS")); len(chats) > 0 {
		return chats
	}
	return csv(os.Getenv("TG_CHAT_ID"))
}

func env(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func envInt(name string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func envDuration(name string, fallback time.Duration) time.Duration {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func csv(value string) []string {
	var values []string
	for _, item := range strings.Split(value, ",") {
		if item = strings.TrimSpace(item); item != "" {
			values = append(values, item)
		}
	}
	return values
}
