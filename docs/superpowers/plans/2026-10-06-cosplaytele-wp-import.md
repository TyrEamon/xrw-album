# 图包导入方案与架构（cosplaytele / misskon / acgmhn）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让本地上传器（`publisher/cmd/xrw-local-uploader`）能在本地页面里浏览多个源站的图包目录，勾选后复用现有 `legacy` 断点管线把原图转存到 Telegram 频道并生成快照批次。站点在 `XRW_WP_SITES` 里配置，按站切换。

**站点一览（2026-10-07 实测）：**

| 站点 | id | 取图方式（第 4 字段） | 图包数 | 索引体积 / 耗时 |
| --- | --- | --- | --- | --- |
| cosplaytele.com | `cosplaytele-com` | `media`（WordPress `media?parent=`） | 5,674 | 2.1 MB / 80 秒 |
| misskon.com | `misskon` | `content`（WordPress 正文 `<img>`） | 49,250 | 21.4 MB / 约 10 分钟 |
| acgmhn.com | `acgmhn` | `acgmhn`（分页 HTML + `ajax_cos`） | 约 36,152 | 约 15 MB / 约 30 分钟 |

**Architecture（实施定稿）:** 站点只是「另一种草稿生产者」。发现层 `internal/sitealbum` 走 WordPress REST API 把目录缓存成 `index.json`（只存元数据，封面热链）；选择层本地页面网格，勾选后调 `POST /api/site-albums/import`；执行层把原图下载进一份 `wp-` 前缀的 `TelegramImportStore` 草稿，之后完全复用既有的草稿编辑弹窗与 `commit` → `Service.Create` → 快照发布链路。**零新增上传/快照路径，`legacy.Runner` 与 `legacy.db` 都不动。** 不内嵌站点、不写油猴脚本、不解析 HTML 图集。

**为什么放弃最初的三层 `legacy.db` 方案：** 原方案要新增 `parked` 状态、`sync-wp`/`activate`/`wp-report` 三个子命令、`/api/wp-albums` 端点，并让本地进程额外持有 `legacy.db` 与 `legacy.Runner`——改动面覆盖 CLI、存储、runner、前端四层，而收益只是「复用已有的下载器」。改成草稿载体后，新增代码集中在两个新包（`sitealbum` + `localupload/siteimport.go`）与前端一个区域，下载/上传/快照全部沿用已上线并有断点重试的路径。代价是导入时原图会临时落盘到草稿目录（约 30 MB/包，提交后随草稿删除），与用户已接受的「原图必须临时下载、传完即删」一致。

**Tech Stack:** Go 1.x（标准库 `net/http` + `encoding/json`）、`modernc.org/sqlite`（现有纯 Go 驱动）、WordPress REST API v2、现有 `internal/legacy`、`internal/telegram`、`internal/localupload`、`internal/snapshot`。

---

## 前提事实（全部实测，2026-10-06）

| 项 | 值 | 来源 |
| --- | --- | --- |
| 文章总数 | 5,674 | `X-WP-Total` on `/wp-json/wp/v2/posts` |
| 媒体总数 | 395,671 | `X-WP-Total` on `/wp-json/wp/v2/media` |
| 分类 / 标签 | 656 / 342 | `X-WP-Total` on `/categories` `/tags` |
| `post` 的 `rest_base` | `posts` | `/wp-json/wp/v2/types` |
| 轻量列表页 | 31,832 B / 100 篇（≈318 B/篇） | `?per_page=100&_fields=id,slug,link,date,modified,title,categories,tags` |
| 列表页 + 封面 | 30,179 B / 10 篇 | `?_embed=wp:featuredmedia` |
| 单篇图集 | 51,201 B / 81 项 | `/wp/v2/media?parent=527286&per_page=100` |
| 单图字节 | 148,982 B（`-1_result.webp`） | `content-range: bytes 0-0/148982` |
| 图集图片尺寸 | `media_details` 900×1600，HTML 属性 1067×1600 | 以实际下载 `image.DecodeConfig` 为准 |
| `media_details.sizes` | **空**（站点关闭了中间尺寸） | 只有 `full` 一份 `_result.webp` |
| CORS | `access-control-expose-headers: X-WP-Total, X-WP-TotalPages, Link` | 分页头浏览器可读 |
| 缓存 | `cf-cache-status: HIT`，支持 Range（206） | 单图响应头 |

**站点自身没有 `X-Frame-Options`，也没有 CSP。** 唯一拦住 iframe 的是本地上传器自己的 `securityHeaders`。

## 三个否决结论

1. **不内嵌 iframe。** 跨源读不到 DOM；且上传器的 CSP（`publisher/internal/localupload/server.go` 的 `securityHeaders`）不含 `frame-src` → 回落 `default-src 'self'`，外部 iframe 直接加载失败。拆掉 CSP 也只是"能看"，仍然"取不到"。浏览挑选这件事**不需要真的嵌那个站**。
2. **不解析 HTML 图集。** `/wp/v2/media?parent=<post_id>` 直接给结构化 JSON：`id`（稳定主键）、`source_url`（原图 URL）、`media_details.width/height`（真实宽高）、`slug`（顺序）。比正则 `<div id='gallery-N'>` 稳得多。
3. **不新增数据库，也不让本地进程碰 `legacy.db`。** 站点索引是一份纯 JSON 缓存（`site-albums/index.json`），导入结果是一份已有的草稿记录。本地进程只写自己的 `local-uploader.db`，VPS 的 `publisher.db` 与 `legacy.db` 都不受影响。

## 数据流（实施定稿）

```
索引      sitealbum.Store          57 请求 / ~2 MB（全量）
         /wp/v2/posts?per_page=100&page=N&_fields=id,slug,link,date,modified,title,featured_media,categories,tags
         /wp/v2/media?include=<封面 id>（每 100 个一批）
         /categories、/tags
         → local-uploader-data/site-albums/<站点 id>/index.json（5,674 条元数据 + 656 分类 + 342 标签）
         → 增量：modified_after=<上次 built_at>，实测 6 秒

浏览      GET /api/site-albums       1 请求 / 页（48 包）
         → 前端用 <img src=cover_url> 热链源站封面，本地不落地任何图片

导入      POST /api/site-albums/import  {"post_ids":[...]}
         → SiteImporter.Queue：每个图包建一份 wp- 草稿，后台 goroutine 抓图
         → /wp/v2/media?parent=<post_id>&orderby=id&order=asc&per_page=100（翻页）
         → 4 并发下载到 os.MkdirTemp 暂存 → 按源站顺序 drafts.AddFile
         → 失败整包回滚（drafts.Delete），原因回显在图包卡片上

发布      复用既有草稿链路，零改动
         编辑弹窗（标题/分类/标签/排序/排除）→ POST /api/telegram-imports/{id}/commit
         → Service.Create → 10 张/组传 TG（批内含 webp 时逐张发，见取舍 5）→ outbox → 快照批次
```

---

### Task 1: 抽出可复用的入库路径

**Files:**
- Modify: `publisher/internal/legacy/store.go`
- Modify: `publisher/internal/legacy/source.go`
- Modify: `publisher/internal/legacy/runner.go`
- Modify: `publisher/internal/legacy/snapshot.go`
- Create: `publisher/internal/legacy/store_test.go`

- [x] `legacy_albums` 新增 `cover_url TEXT NOT NULL DEFAULT ''` 与 `source TEXT NOT NULL DEFAULT 'linuxdo-85w'`；`Open` 里用新增的 `addMissingColumns(db, table, columns)`（读 `PRAGMA table_info` 后按名字排序 `ALTER TABLE ... ADD COLUMN`）给已存在的库回填，保证旧库打开即升级。
- [x] `SourceAlbum` 新增 `Cover`、`Source` 字段（`ID/Ordinal/Title/Cover/Source/URLs`）；新增常量 `SourceLinuxDO85W`；`ParseSource` 的 `flush()` 补这两个字段，`sourceAlbumID(ordinal, title, cover)` 调用不变，`source_test.go` 的 ID 断言仍然成立。
- [x] `SyncSource(ctx, path, chats)` 改为 `SyncAlbums` 的薄包装：`return s.SyncAlbums(ctx, chats, SyncStatusPending, func(visit func(SourceAlbum) error) error { return ParseSource(path, visit) })`。
- [x] 新增 `func (s *Store) SyncAlbums(ctx context.Context, chats []string, status string, walk func(visit func(SourceAlbum) error) error) (int, int, error)`：单事务 + 两条 `PrepareContext`；album upsert 写入 `status/cover_url/source`，`DO UPDATE` **不含 status**，因此重跑同步不会把已发布图集拉回队列；新增常量 `SyncStatusPending = "pending"` / `SyncStatusParked = "parked"`，非法 status 与空 chats 直接报错。
- [x] 新增 `func (s *Store) ActivateAlbums(ctx context.Context, ids []string) (int, error)`：单事务把 `parked` 翻成 `pending`，条件带 `expected_count > 0` —— 防止空图集进 runner 后 `writeOutbox` 越界。
- [x] 新增 `func (s *Store) ListAlbums(ctx context.Context, filter AlbumFilter) ([]Album, int, error)`（`AlbumFilter{Status, Query string; Limit, Offset int}`）：先 `COUNT(*)` 再分页取；搜索用 `instr(lower(...), lower(?))` 而非 `LIKE`，避免用户输入的 `%`/`_` 变成通配符。
- [x] 新增 `func (s *Store) SetAlbumImages(ctx context.Context, albumID string, urls []string) error`：只允许对 `parked` 图集替换图片列表，同时回填 `expected_count`。
- [x] `Album` 新增 `CoverURL`、`Source`；`Stats` 新增 `Parked`；`ClaimNext`、`SnapshotAlbum` 的 SQL 与 `Scan` 同步带上新列。
- [x] `runner.go` 的 `writeOutbox` 与 `snapshot.go` 的 `ExportSnapshot` 把硬编码的 `"source": "linuxdo-85w"` 改为读 `album.Source`（空则回落 `SourceLinuxDO85W`）；`writeOutbox` 与 `ExportSnapshot` 都对空 `photos` 做保护，避免 `photos[0]` 越界。
- [x] 新增 `store_test.go`：`parked` 不入队、`ActivateAlbums` 的守卫、`SetAlbumImages` 拒绝非 parked、重跑同步保留已发布状态、`ListAlbums` 的分页/搜索/`%` 不通配、旧库自动补列且幂等。
- [x] `go build ./...`、`go test ./...` 全绿。

### Task 2: WordPress 源适配器

**Files:**
- Create: `publisher/internal/legacy/wordpress.go`
- Create: `publisher/internal/legacy/wordpress_test.go`

- [x] `WordPressSource{BaseURL, PerPage, Client}` + `NewWordPressSource(baseURL, client)`（空 baseURL → `DefaultWordPressBase`，nil client → 60s 超时默认 client，自动走 `HTTPS_PROXY`）。常量 `SourceCosplaytele = "cosplaytele"`、`wordpressUserAgent = "xrw-legacy-wp/1.0"`。
- [x] `Walk(ctx, WPWalkOptions, visit func(SourceAlbum) error) error` 翻列表页，`readWPPage` 读 `X-WP-Total`/`X-WP-TotalPages`；产出 `SourceAlbum{ID: "wp-<post_id>", Ordinal: wordpressOrdinalBase + post_id, Source: SourceCosplaytele, Cover: ...}`，`wordpressOrdinalBase = 100000000` 避免与 linuxdo-85w 的 `ordinal` 撞唯一索引。
- [x] `Media(ctx, postID)` 分页取 `parent=` 的全部附件（`per_page=100&orderby=id&order=asc&_fields=id,slug,source_url,mime_type`）；`per_page` 硬上限 100，>100 张的图集必须翻页（实测 173 张的图集分两页返回 174 条）。
- [x] `AlbumImages(ctx, postID)` + 纯函数 `AlbumFromMedia(items, coverID, claim)`：先按 `mime_type` 丢掉非 `image/*`，再用 **slug 前缀主导组** 丢掉混进来的别家附件，最后用 **标题里的张数** 决定封面去留 —— `len == claim+1` 时剔封面，`len == claim` 时全保留，剔完对不上就整份保留。**不能无条件剔封面**：实测 527293 的封面是相册内第 20 张，527286 的封面才是多出来的 `-81`。
- [x] `Meta(ctx, postID)` 用四条正则提 `Cosplayer` / `Character` / `Appear In` / `Unzip Password`；`ParsePostTitle` 解 HTML 实体并取**最后一个** `N photos` 匹配，同时抽出 `videos` 数。
- [x] `Covers(ctx, ids)` 用 `media?include=` 每 100 个一批把 `featured_media` 解析成封面 URL；`CategoryNames(ctx, ids)` 批量取分类名。
- [x] `httptest` 套件覆盖分页、封面两种形状、混入别家附件、命名不统一的图集、非图片附件、5xx 重试、`Meta`/`CategoryNames`。
- [x] `TestWordPressLive`（`XRW_WP_LIVE=1` 才跑）对真实站点最新 24 篇逐篇断言 `len(AlbumImages) == 标题张数`：**24/24 全部吻合**，含 173 张的大图集与混入别家附件的 526721。
- [x] `go vet`、`gofmt -l`、`go test ./...` 全绿。

### Task 3: 站点索引缓存（`internal/sitealbum`）

**Files:**
- Create: `publisher/internal/sitealbum/store.go`
- Create: `publisher/internal/sitealbum/store_test.go`
- Modify: `publisher/internal/legacy/wordpress.go`

- [x] `legacy` 侧新增 `FeaturedIDs(posts []WPPost) []int`（原 `featuredIDs` 导出）与 `Terms(ctx, taxonomy, orderBy)`（按 `taxonomyPath` 只接受 `categories|category|tags|tag`，防止把请求打到任意端点）。
- [x] `sitealbum.Store` 把目录缓存成 `index.json`：`Album{ID,Slug,Link,Title,Photos,Videos,CoverID,CoverURL,Categories,Tags,Date}`、`Term`、`Index{BuiltAt,RefreshedAt,Albums,Categories,Tags}`。`save` 写 `.tmp` 后 `os.Rename`，`ensureLoaded` 懒加载（缺文件正常，坏文件只 Warn 等刷新重建）。
- [x] `Refresh(ctx, full)` 同步版（首启与测试用）、`StartRefresh(full) bool` 后台单飞版、`begin()/finish(err)` 管 `building/progress/error`。全量用 `OrderBy:"id" Order:"desc"`；增量用 `ModifiedAfter: BuiltAt` + `OrderBy:"modified"`，且**保留旧 `BuiltAt`** 让增量窗口不滑走。
- [x] `List(Filter{Query, CategoryID, Page, PerPage})`：`Query` 走大小写不敏感的字面量匹配（不用 SQL `LIKE`），`PerPage` 越界回落 48、上限 200。
- [x] `store_test.go`：`fakeSite` 覆盖分页、封面两种形状、分类/标签、失败保留旧索引、磁盘重载、增量窗口。**实测 `go test ./internal/sitealbum/...` ok。**

### Task 4: 站点导入器与后端接线

**Files:**
- Create: `publisher/internal/localupload/siteimport.go`
- Create: `publisher/internal/localupload/siteimport_test.go`
- Modify: `publisher/internal/localupload/telegram_import.go`
- Modify: `publisher/internal/localupload/server.go`
- Modify: `publisher/internal/localupload/server_test.go`
- Modify: `publisher/internal/config/config.go`
- Modify: `publisher/cmd/xrw-local-uploader/main.go`

- [x] `TelegramImportStore` 泛化为「草稿」载体：草稿新增 `Kind`（`KindTelegram="tg"` / `KindWordPress="wp"`）与 `Category`，`Create` 用 `draftKind()` 决定 ID 前缀。API 路径保持 `/api/telegram-imports/*` 不变，油猴脚本无需改动。
- [x] `SiteImporter`：`Import(ctx, SiteImportRequest)` 同步（单包，测试用）、`Queue(ids) int` 后台排队（并发上限 `siteImportAlbums=2`，`claim/release` 保证同一图包不重复导入，失败原因留在 `failed map[int]string` 供前端显示）、`Bind(ctx)` 挂进程级 ctx（**后台导入不能继承 request ctx**）。
- [x] 抓取：`source.AlbumImages` 取图 → `os.MkdirTemp` 暂存 → 4 并发 `stage` → **按源站顺序**逐个 `drafts.AddFile`（`AddFile` 按到达顺序编号，顺序错了草稿就乱了）。任一图失败则整包 `drafts.Delete` 回滚。
- [x] 路由：`GET /api/site-albums`（`q`/`category`/`page`/`per_page`，返回 `albums`+`categories`+`tags`+`status`）、`POST /api/site-albums/refresh`（body 可省；空索引强制全量；已在跑返回 409）、`POST /api/site-albums/import`（body `{"post_ids":[...]}`，返回 202 `{"accepted":n}`，全被占用返回 409）。
- [x] `siteAlbumView` 把草稿状态并进图包视图（`draft_id` / `committed_job_id` / `importing` / `error`），未提交的草稿优先于已提交的匹配同一 `source_url`。
- [x] CSP 改为运行时拼接 `img-src`：`'self' data:` + `siteOrigin(baseURL)`，其余指令不动。
- [x] 配置：`XRW_WP_BASE`（默认 `https://cosplaytele.com`，`off`/`none`/`-` 关闭）、`XRW_WP_REFRESH`（默认 `6h`）；`main.go` 在站点启用时装配 store/importer，启动后跑一次 `StartRefresh(false)` 并按间隔增量刷新。
- [x] `siteimport_test.go`：`fakeGallerySite` 吐真 PNG 字节，覆盖「按序填充草稿且剔封面」「未知图包」「缺图整包回滚」「后台排队」「失败上报」。`server_test.go` 新增 `TestSiteAlbumEndpointsBrowseAndQueueGalleries`（列表 + CSP + 排队 + 409 + 草稿回链 + `/api/state`）。**全部通过。**

### Task 5: 前端「站点图包」区域

**Files:**
- Modify: `publisher/internal/localupload/web/index.html`
- Modify: `publisher/internal/localupload/web/app.js`
- Modify: `publisher/internal/localupload/web/styles.css`

- [x] `index.html` 新增编号 02 的「站点图包」区域（搜索框 + 分类下拉 + 状态行 + 更新列表 + 导入所选 + 网格 + 翻页），`template#site-template` 定义卡片；原「Telegram 草稿」改称「导入草稿」并顺延为 03，本地任务顺延为 04。
- [x] 卡片封面 `loading="lazy"` + `referrerpolicy="no-referrer"`（不把本地页面地址泄露给站点），显示标题、`N 张 / N 个视频 / 日期`、状态徽标（未导入 / 正在导入… / 草稿就绪 / 已发布）与「源站页面」外链；有草稿时多一个「打开草稿」按钮，直接复用既有编辑弹窗。
- [x] `app.js` 加 `loadSiteAlbums/renderSiteAlbums/renderSiteCategories/renderSiteStatus/syncSiteImportButton`，复用既有 `api()` 封装与 toast；搜索框去抖 320 ms，轮询每 2 秒（与既有 `/api/state` 轮询共用）。
- [x] `.site-pick` 复选框用 `appearance:none` 自绘——全局 `input` 规则会污染原生 checkbox。
- [x] 工具栏「本页全选」（`#site-select-all`）：`sitePageIDs` 记录本页可导入的图包 id，`syncSiteSelectAll()` 据此算 `disabled / checked / indeterminate`；勾选即批量增删 `sitePicked` 并同步可见复选框。CDP 实测：48 张卡全选 → 48 选中、按钮变「导入所选 48 个」；单选 1 张 → 全选框 `indeterminate=true`；取消 → 按钮回到 disabled。
- [x] 状态行 `#site-status` 独占一行并 `overflow-wrap: anywhere`，失败原因截断到 120 字（完整内容留在 `title`）——否则刷新失败时的完整上游 URL 会横向撑破面板。（后续 Task 7 把它挪进了标题栏。）
- [x] 手动验证（真实站点）：索引 5,674 包 / 656 分类 / 342 标签；封面热链正常；导入 `380202`（6 张 1 视频）得草稿 `wp-20261006-092812-56533cb6`，6 张 WebP 真实宽高 2560×13xx，封面按规则剔除。

### Task 6: 增量与对账

**Files:**
- Modify: `publisher/internal/sitealbum/store.go`
- Modify: `publisher/cmd/xrw-local-uploader/main.go`

- [x] `Refresh(full=false)` 用 `ModifiedAfter` 只读改动过的图包，并保留旧 `BuiltAt`。**实测真实站点增量 6 秒，总数保持 5,674。**
- [x] `main.go` 的 `startSiteRefreshLoop` 按 `XRW_WP_REFRESH` 定时增量；上一轮未跑完就跳过这一轮并记日志。
- [x] 前端「更新列表」按钮按住 `Shift` 触发全量重建。
- [x] 对账方式改为「图包视图状态」而非 CLI 报告：每个图包卡片直接显示 `未导入 / 正在导入 / 草稿就绪 / 已发布`，`/api/site-albums` 的 `total` 与源站 `X-WP-Total` 可肉眼比对（实测 5,674 == 5,674）。

### Task 7: 多站点与区域可收起

**Files:**
- Modify: `publisher/internal/config/config.go`、`publisher/internal/sitealbum/store.go`
- Add: `publisher/internal/sitealbum/registry.go`
- Modify: `publisher/internal/localupload/siteimport.go`、`server.go`、`publisher/cmd/xrw-local-uploader/main.go`
- Modify: `publisher/internal/localupload/web/{index.html,app.js,styles.css}`
- Modify: `publisher/README.md`、`publisher/local-uploader.env.example`

- [x] `config.go`：`Config.WordPressBaseURL` 换成 `WordPressSites []WordPressSite`（`ID/Name/BaseURL`），新增 `XRW_WP_SITES`（一行、逗号分隔，每站写 `url` / `id|url` / `id|name|url`，优先于 `XRW_WP_BASE`）；id 缺省由主机名 slug 化（`cosplaytele.com` → `cosplaytele-com`），重复 id 自动追加 `-2`；URL 只保留 `scheme://host`，非 http/https 或无 host 报错。`XRW_WP_BASE` 与 `off`/`none`/`-` 的关闭语义不变。
- [x] 新增 `sitealbum.Registry`：每站一份 `<数据目录>/site-albums/<id>/index.json` 与独立 `Store`；`Target(id)` 空 id 回落首站、未知 id 报错；`Status()` 返回 `[]SiteStatus`；`StartRefreshAll`/`RefreshAll` 用 `errors.Join` 汇总失败（失败包成 `<id>: %w`），**一个站挂了不影响其他站**。`adoptLegacyIndex` 在单站配置下把旧的扁平 `<数据目录>/site-albums/index.json` `os.Rename` 进 `<id>/`，升级后无需重扫 5,674 篇。
- [x] `sitealbum.Store.Status` 去掉 `BaseURL`（改由 `SiteStatus.Site` 提供），消除 `ambiguous selector` 编译错误。
- [x] `siteimport.go` 改为注册表驱动：`SiteImportRequest` 加 `site_id`，进行中/失败表改用 `站点+图包` 复合键（`siteID + "\x00" + postID`），`Queue(siteID, ids)` / `IsActive(siteID, postID)` / `Failure(siteID, postID)` / `ActiveFor(siteID)`；`download` 的 `Referer` 取该站自己的 origin。
- [x] `server.go`：`ServerOptions.Site` → `Sites *sitealbum.Registry`；CSP 的 `img-src` 遍历全部站点去重拼接；`siteStatus()` 返回数组（无站点返回 `nil`）；新增 `resolveSite` 统一处理未知 id 的 404；三条站点端点接受 `site` 参数，响应体回带 `"site"`。
- [x] `main.go`：装配 `Registry` + `startSiteRefreshLoop(ctx, *Registry, …)`。
- [x] 前端：标题栏新增站点下拉（只有一个站时自动隐藏，`renderSitePicker` 按 `[[id,name]]` 签名去抖）与「收起/展开」按钮（`localStorage['xrw.siteCollapsed']`，`applySiteCollapsed` 同步 `#site-body.hidden`、按钮文案与 `aria-expanded`）；切站清空搜索、分类、页码与勾选（分类编号和图包 id 只对原站点有意义）；收起时 `loadSiteAlbums()` 直接返回，不再空转请求。
- [x] 测试：`config_test.go` 7 个多站解析用例；新增 `sitealbum/registry_test.go`（一站一索引、默认站与未知站、重复 id、旧扁平索引迁移、`RefreshAll` 报出失败站名）；`server_test.go` 新增 `TestSiteAlbumEndpointsSwitchBetweenSites`（两站状态顺序、按站取列表、CSP 含两个源、按站导入、按站刷新）。
- [x] 文档：`local-uploader.env.example` 与 `README.md` 的站点段改成多站说明（**env 文件每行一个 `NAME=value`，多站必须写在同一行用逗号分隔**；换行分隔只对真实进程环境变量有效）。
- [x] 实测（真实站点 + 本地演示站）：单站升级不重扫（`total` 仍 5,674，扁平索引被搬进 `site-albums/cosplaytele-com/`）；两站时下拉出现 `Cosplaytele` / `演示站`；切站后勾选从 4 → 0、网格从 4 张换到 48 张；收起后 `#site-body` 隐藏、按钮变「展开」、刷新页面后仍保持收起；真实站点导入 `Minami – Masturbation – Part 4`（15 张）得草稿 `wp-20261006-112309-b181b1be`，**草稿 15 个文件 == 标题声明的 15 张**。
- [x] `gofmt -l .`、`go vet ./...`、`go test ./...` 全绿。

---

### Task 8: 修 webp 批次被 Telegram 判成贴纸

**Files:**
- Modify: `publisher/internal/telegram/client.go`、`client_test.go`
- Modify: `publisher/README.md`

- [x] 复现：真实站点导入 122 张 `.webp` 的任务 `manual-20261006-3949e2a7` 全部失败，报 `Telegram Bot API HTTP 400: Bad Request: failed to send message #1 with the error message "Wrong file identifier/HTTP URL specified"`（该串出自 `client.go:169` 的 `fmt.Errorf("Telegram Bot API HTTP %d: %s", …)`）。
- [x] 用真实 bot 打真实 API 枚举成因（同一份 webp 字节，只改上传方式）：单文件 `sendDocument` 下 `.webp`+`image/webp` → 贴纸、`.webp`+`application/octet-stream` → 贴纸、`.png`+`image/png` → document、`.bin`+`application/octet-stream` → document、`.webp0`+`image/webp` → 失败、`.webp`+`image/webp`+`disable_content_type_detection=true` → document；media group `type:document` 下 `.webp` → 失败（`disable_content_type_detection` 在 `sendMediaGroup` 上无效）、`.png`+`image/png` → 成功且 `mime_type=image/png` 字节数不变；media group `type:photo`+`.webp` → 成功但被转成 JPEG（112652→218752 字节）。
- [x] `UploadGroup` 把请求主体抽成 `uploadOnce(ctx, chatID, items, caption)`（保留 `c.wait` 节流与并发信号量），非 webp 批次行为不变；`containsWebP(items)` 为真时改为逐张 `uploadOnce(…, []UploadItem{item}, …)`，只有第 0 张带 caption，按序 append。
- [x] 新增 `containsWebP` / `isWebP`（`filepath.Ext == ".webp"` 或 `ContentType == "image/webp"`，均 `EqualFold`）；`writeUploadForm` 单文件分支对 webp 写 `disable_content_type_detection=true`；`botMessage` 加 `Sticker` 字段，只回 sticker 不回 document 时报「Telegram 把第 %d 个文件当成贴纸（.webp）」。
- [x] 测试：`TestIsWebPMatchesTelegramStickerDetection`、`TestUploadSendsWebPOneDocumentPerRequest`（只打 `/sendDocument`、`disable_content_type_detection=true`、caption 只在第一张、顺序与 mime 不变）、`TestUploadSplitsMixedBatchWhenAnyFileIsWebP`。
- [x] 真机验证：临时用生产 `UploadGroup` 打真实 Bot API 传两张真 `.webp` → 返回 `document`、`mime_type="image/webp"`、`message_id=267015/267016`，随后两条消息已 `deleteMessage` 清理；探针文件已删除。
- [x] `gofmt -l .`、`go vet ./...`、`go test ./...` 全绿。

---

### Task 9: 接入 misskon.com（正文取图 + 边走边写 + 「不全」角标）

**Files:**
- Modify: `publisher/internal/legacy/wordpress.go`、`publisher/internal/sitealbum/store.go`、`publisher/internal/config/config.go`、`publisher/internal/localupload/{server.go,web/index.html,web/app.js,web/styles.css}`、`publisher/README.md`、`publisher/local-uploader.env.example`

- [x] 取图策略按站点可配：`XRW_WP_SITES` 第 4 字段 `media`（默认，cosplaytele 用 `media?parent=`）/ `content`（misskon 用正文）。**动因**：misskon 的 `media?parent=<postId>` 只返回 1 项（就是封面），套图全部内嵌在 `content.rendered` 里。
- [x] `ImagesFromContent(rendered string) []WPMedia`：按**文档顺序**取 `<img>`，优先 `data-src` 再 `src`（`lazy` 图集的真图在 `data-src`），正则 host 无关（`(?i)\.(?:webp|jpe?g|png|gif|avif)$`）—— **教训**：第一版只匹配 `/imghost/` 路径，把老版 `/images/` 路径的图全漏了，得出「600 个图包没图」的错误结论。
- [x] `Contents(ctx, ids []int) (map[int][]WPMedia, error)`：用**列表端点** `posts?include=<ids>&per_page=100&_fields=id,content` 一次量一整页（`maxContentBatch=100`）。实测列表端点的 `content.rendered` 与单篇端点完全一致，所以一页 48 个图包只花 1 次请求。**踩坑**：路径参数要写 `"/posts"`（`get()` 已拼 `/wp-json/wp/v2` 前缀），写成 `"wp-json/wp/v2/posts"` 会拼成 `…/wp-json/wp/v2/wp-json/wp/v2/posts`。
- [x] 「不全」角标：`sitealbum.Album` 新增 `Actual`（真实张数），`Verify(ctx, ids)` 量数并落盘（`recordActual` / `carryActual`，标题变了才重量），`POST /api/site-albums/verify`（每批 100 个 id、一次最多 `maxVerifyAlbums=120` 个），前端按页懒量、左下角琥珀色角标显示 `36 / 111 张`。**动因**：misskon 大量图包的正文被截断到 12/24/36 张，而标题声明的是真实总数。
- [x] 边走边写：`publishEveryPages = 25`，第 1 页立刻落盘、之后每 25 页一次；`Index.Partial` 标记「没走完」的索引（下次强制全量）；`publish` 改成**并集**（`previous.Albums` ∪ 已读），被杀掉也不丢图包。**关键决定：放弃「失败即回滚」，改为「失败即保留并标记 partial」** —— 回滚会把本来就截断的索引一直锁住（真机上就是被这个坑到：第一次全量在第 339/493 页遇到 `HTTP 522` 被打回 12,500）。
- [x] 重试与超时：`wordpressMaxAttempts = 5`（1/2/4/8 秒退避）、新增包级 `defaultClient`（`TLSHandshakeTimeout: 30s`、`ResponseHeaderTimeout: 45s`）。**动因**：默认 transport 的 10 秒握手超时走代理时会被 `net/http: TLS handshake timeout` 打死（真机第 3 页就是这个错）。
- [x] 前端：状态行显示「正在读取第 N/M 页 · 已读到 X 个」，15 秒节流后自动重载网格，翻页总数跟着涨。
- [x] 测试：`TestContentsMeasuresSeveralPostsAtOnce`（断言 1 次请求 + `include=` + 路径）、`contentSite(t)` 夹具 + `TestVerifyRecordsActualCounts`、`TestSiteAlbumVerifyEndpointReportsRealCounts`、`TestPostsRetriesATransientServerError` / `TestPostsDoesNotRetryAClientError`、`TestRefreshPublishesWhatItHasSoFar` / `TestFailedWalkKeepsWhatItRead` / `TestPartialIndexIsRebuiltWhole`。
- [x] 真机：全量 49,250 个图包 / 索引 21.4 MB / 约 10 分钟（中途第 266、433 页各卡约 1 分钟，靠新重试扛过）；导入 118985 得草稿 `wp-20261007-035533-95e380d3`（18 张 `.webp`）。

---

### Task 10: 接入 acgmhn.com（可插拔取图源 + 限速 + 空页不截断）

**Files:**
- Add: `publisher/internal/legacy/acgmhn.go`、`publisher/internal/legacy/acgmhn_test.go`
- Modify: `publisher/internal/sitealbum/{store.go,registry.go,store_test.go}`、`publisher/internal/legacy/wordpress.go`、`publisher/internal/config/{config.go,config_test.go}`、`publisher/internal/localupload/server.go`、`publisher/README.md`、`publisher/local-uploader.env.example`

- [x] 站点没有 REST API（不是 WordPress），只有分页 HTML，所以把取图源抽象成接口：`sitealbum.Source{Base / Posts / Covers / Terms / AlbumImages}`，可选能力 `Measurer`（`Verify` 用类型断言，acgmhn 不实现 ⇒ 不显示「不全」角标，因为 `pagenum` 本来就准）。
- [x] `AcgmhnSource`：列表 `/cos/` + `/cos/index-N.html`（每页 36 条），`<span class="pagenum">` 取真实张数，视频条（`00:07` 这种时长）用 `^\d+P$` 过滤掉；`Covers` 直接答上次列表的封面表（0 额外请求）。**必须带浏览器 UA**：不带会被 Cloudflare 返回 `Just a moment...` 挑战页（403），带上就放行；直连 000，必须走 `HTTPS_PROXY`。
- [x] 取图：`GET /ajax_cos/<id>.html?ajax=1`（第 N 页 `/ajax_cos/<id>-N.html?ajax=1`，约 240 字节 JSON）逐页取 `pic`，停止条件是 `pic` 为空或 `canajax[1] == 0`。图片文件名是字典序排的（`7_0021` → `7_00210`…`7_00219` → `7_0022`），URL 不可预测，只能逐页读。
- [x] 限速：每次尝试前等 `Delay`（默认 1 秒）；实测突发 21 个后开始 429/200 交替，空闲 20 秒后按 1 秒间隔全部 200 ⇒ 1 req/s 是安全值；429/5xx 按 1/2/4/8 秒退避，403 直接报 `HTTP 403 (Cloudflare challenge)`。
- [x] **修掉「整页视频把走查提前结束」**：`/cos/` 的列表页混着视频条，第 2、3、4 页**整页都是视频**（`00:16`…），解析器正确过滤后得到 0 条，而 `len(posts) == 0 → break` 把空页当成「站走完了」，真机全量只得到 29 个图包。修法：`WPPage` 新增 `More`（页面在列表范围内、只是没有可导入条目），walk 改成 `len(posts) == 0 && !info.More` 才停；同时把总页数**固定在第一个报告页数的页**（尾页分页器会报出不存在的 `totalPages=1007`，跟着走会跑飞），并把 `page <= 1000` 的硬编码换成 `maxWalkPages = 5000`（acgmhn 有 1005 页）。
- [x] 配置：`XRW_WP_SITES` 第 4 字段扩成 `media | content | acgmhn`；CSP 的图片策略判定改用 `sitealbum.ImagesOutsideBase(imageSource)`（acgmhn 的图在 `m.acgnfl.com`，没法预先枚举 host，所以放宽到任意 `https:`）。
- [x] 测试：`acgmhn_test.go` 11 个用例（列表解析、封面复用、逐页取图、空页继续、追平即停、浏览器头、429 重试、翻页 URL、`More` 语义）；`TestRefreshWalksPastAPageWithNothingToImport`；`TestRegistryPicksTheReadingStrategy`、`TestImagesOutsideBase`、`TestWordPressSitesReadsTheAcgmhnEngine`。
- [x] `TestAcgmhnLive`（`XRW_ACGMHN_LIVE=1` + 代理）：`/cos/` 共 1005 页、首个图包 884182 `23P`、图包 869301 取到 9 张与 `9P` 一致 ⇒ **这个站没有 misskon 那种截断问题**。
- [x] 文档：`README.md` 第 177 行起补第 4 字段与 acgmhn 取图方式；`local-uploader.env.example` 第 43–50 行补三站示例；`local-uploader.env` 第 17 行改为三站。
- [x] 真机全量索引：**23,725 个图包**（`partial: false`、`built_at == refreshed_at == 2026-10-07T16:47:13Z`），索引 6.5 MB。比按「36 条 × 1005 页」估的 36,152 低一万多，原因是新图包区混着大量视频（前几页甚至整页是视频，整页被过滤），每页平均只有 17 个图包。中途被打断过一次（停在 386,951 字节的 partial 状态，重启后跑完）。
- [x] 真机导入验收：勾选 `884182`（`23P`）→ `POST /api/site-albums/import` 返回 202，约 75 秒后完成，草稿 `wp-20261007-162336-326ceec3` 得到 **23 个 `000001.webp`…`000023.webp`（`image/webp`，1000×1500）**，与 `pagenum` 声明的 23 张完全一致；草稿第一条的 `source_message` = `https://m.acgnfl.com/26/10/c54/884182/7_0021.webp`，与源站第 1 页 `ajax_cos` 返回的 `pic` 完全相同 ⇒ 顺序与字节都正确。列表接口不返回 `actual`（acgmhn 不实现 `Measurer`），因此卡片不显示「不全」角标，符合预期。

---

### Task 11: 站点导入的「抓取中…／导入完成」观感

- [x] **动因**：`SiteImporter.fill` 是「先把全部图下到临时目录、到齐后才写进草稿」，所以草稿从建好到写完之间**真的是 0 张**（`0 张 · 0 B`）—— 用户看到的不是 bug，但页面没有任何提示。
- [x] 后端：`SiteImporter` 新增 `filling map[string]int` 与 `Filling` / `markFilling` / `unmarkFilling`（`runImport` 在 `drafts.Create` 之后、`fill` 之前标记，`defer` 解除）；`server.go` 新增 `importView` + `draftViews`，`/api/state` 的 `telegram_imports` 因此带上 `importing` 与 `target_count`。
- [x] 前端：草稿卡抓取中显示 `抓取中… 目标 N 张`（琥珀色 `.telegram-summary.filling`），`检查并导入` / `删除草稿` 同时禁用；图包卡角标 `抓取中…` → `导入完成`；离开抓取态时 `announceFilledImports` 弹一句 `导入完成：<标题>（N 张）`。
- [x] **修掉「角标停在抓取中」**：网格原本只在 `status.importing || grown || ticking` 时重载，导入一结束三个条件全假 ⇒ 卡片永远停在 `抓取中…`。改成记住上一次的 `importing` 计数，归零那一拍补一次重载；并加 `siteReloadWanted`，让被 `siteBusy` 挡掉的请求留到下一次而不是丢掉。
- [x] 测试：`TestImporterMarksItsDraftWhileItFills`（`gate` 卡住下载再放开）、`TestStateReportsADraftThatIsStillBeingFilled`。
- [x] 真机验收：勾选 `ATFM – Tsubaki – Collection – Part 2`（31 张）→ 262 ms 时草稿卡已是 `抓取中… 目标 31 张`、角标 `抓取中…`；3.7 秒后 toast「导入完成：ATFM – Tsubaki – Collection – Part 2（31 张）」、草稿 `31 张 · 2.1 MB`、角标同一拍变 `导入完成`。截图 `D:\Desktop\gitr\_tmp\shot-import-done.png`。
- [x] `gofmt -l .`、`go vet ./...`、`go test ./...` 全绿。

---

## 容量与限速预算

- 索引（全量，各站独立文件 `<数据目录>/site-albums/<id>/index.json`）：
  - `cosplaytele-com`：57 请求 / 2.1 MB / 约 80 秒；增量 6 秒。
  - `misskon`：493 页 × `per_page=100` / 21.4 MB / 约 10 分钟；增量走 `modified_after`。
  - `acgmhn`：1005 页 × 36 条 / 约 30 分钟（受 1 req/s 限速约束）/ 实测 23,725 个图包（视频条被过滤，每页平均 17 条）；列表按 id 倒序，所以增量可以「遇到全已知即停」。
- 浏览：0 下载。封面全部热链源站，实测单图 0.29–0.32 s（`cf-cache-status: HIT`，131–206 KB）；acgmhn 的封面与正文图都在 `m.acgnfl.com`，实测可热链（带外站 referer 也 200）。
- 导入：1 包 = 1 次取图（`media?parent=` / 正文列表端点 1 次 / acgmhn 每页 1 次）+ N 张图下载；4 并发，均 ~150 KB/张。acgmhn 的取图按 1 秒间隔串行，一个 23 张的图包约 25 秒。
- 上传端：完全沿用既有约束（`TG_MAX_CONCURRENT`、`TG_UPLOAD_INTERVAL=3500ms`、`TG_GLOBAL_INTERVAL=500ms`、10 文件/组；批内含 webp 时退化为逐张，见取舍 5）。
- 磁盘：导入期单包约 30 MB（暂存在 `local-uploader-data/site-import/` 下的临时目录，写完草稿即删）；草稿保留到提交成功，快照就绪时由既有 `RemoveByJob` 清理。索引文件本身（实测）：cosplaytele 2.06 MB + misskon 20.4 MB + acgmhn 6.5 MB ≈ 29 MB。

## 已排除的选项

- **内嵌 iframe** —— 跨源 + CSP `frame-src` 双重阻塞，且能看不能取。
- **Mediafire / Gofile / SoraFolder 外链** —— 需要另一套下载器 + 解压（`Unzip Password` 实测 `cosplaytele`），与现有 TG 管线不兼容；且 Mediafire 按钮的 `<a>` **没有 `href`**，不可依赖。
- **抓视频** —— 33 个视频不在站内，只在 `cossora.stream/embed/<uuid>` 播放器和外部包里。一期只做图。
- **爬 HTML 图集** —— 已被 `/wp/v2/media?parent=` 的结构化 JSON 取代。
- **全站 media 遍历**（3,957 页）—— 不如按需 `parent=` 精准。
- **`legacy.db` + `parked`/`pending` 三层方案** —— 见顶部「为什么放弃」。
- **封面本地缓存** —— 本地进程与浏览器走同一个代理，缓存只能省重复浏览的带宽，却要额外维护一个缓存目录与失效策略；热链更简单，且实测无防盗链。

## 实施后仍然存在的取舍

1. **封面热链** —— 已定：热链 + 运行时拼 `img-src`。代价是页面需要能访问源站；无代理时封面空白，其余功能不受影响。
2. **一期不含视频** —— 已定：只导入图片，视频卡片仍显示 `N 个视频` 但不会被下载。
3. **多站只能写在一行** —— 已定：`local-uploader.env` 的解析器是严格的逐行 `NAME=value`（空行与 `#` 注释除外），不支持续行。因此 `XRW_WP_SITES` 在 env 文件里必须写成一行、逗号分隔；`splitList` 仍保留换行分隔，只有把变量设在真实进程环境里时才用得上。解析失败时的报错已补上「each variable must fit on one line」提示。
4. **草稿的分类与标签留空** —— 源站 REST 不暴露 `Cosplayer`/`Character` 元数据（实测 `meta` 只有 `footnotes`），且分类是源站自己的词表（`Cosplay Nude` 等），直接当标签会污染用户自己的词表。因此草稿只带标题与源站链接，分类/标签由用户在编辑弹窗里填写；`commitTelegramImport` 已支持「请求为空则回落到草稿的值」。
5. **含 webp 的批次失去媒体组布局** —— 已定：逐张上传。源站原图是 `.webp`，而 Telegram Bot API 按分片文件名/声明 MIME 分类，`*.webp` 与 `image/webp` 一律被判成贴纸；`sendMediaGroup` 的 `attach://document0` 只能引用 document，于是整组 400 `failed to send message #1 ... "Wrong file identifier/HTTP URL specified"`（首次真实导入 122 张全部失败即此因）。修复 = `UploadGroup` 检测到批内含 webp 就改成逐张 `sendDocument`，并给单文件分支加 `disable_content_type_detection=true`。这样原始 WebP 字节、`000001.webp` 文件名与 `image/webp` MIME 全部原样保留。**被否决的两条替代路线**：① 本地把 webp 转成 PNG/JPEG —— 实测 webp 1067x1600 112652B → PNG 2409241B（21.4 倍）、JPEG q92 265885B（2.36 倍），PNG 体积和站点带宽都不可接受，JPEG 有损；② 只把文件名改成 `.png` 而字节仍是 webp —— `cf-image-worker/src/index.js:88` 用 `tg_files.content_type`（即 Telegram 返回的 `document.mime_type`）写 `Content-Type` 并带 `X-Content-Type-Options: nosniff`，错误 MIME 会一路传到站点。代价：122 张按 `TG_UPLOAD_INTERVAL=3500ms` 逐条发，约 8 分钟，观感从「一个相册」变成「一列文件」；快照只记录每个文件的 `TGMessageID` 与 mime，不记录 group id，下游无影响。
6. **acgmhn 靠 1 秒间隔硬扛限速** —— 已定：该站没有任何 API，只有分页 HTML 与每页 1 张图的 `ajax_cos` 接口，且突发 20 余个请求后开始 429。因此取图串行 + 1 秒间隔（`AcgmhnSource.Delay`），全量索引约 30 分钟。代价：一个 60 张的图包要 1 分钟才抓好；好处是不需要 cookie、不需要浏览器，也不会把站点打疼。同站点也没有「不全」问题（`<span class="pagenum">` 就是真实张数），所以不接 `Measurer`，不显示角标。
7. **acgmhn 的视频条只能跳过** —— 已定：`/cos/` 列表里混着视频（`pagenum` 是 `00:16` 这种时长），一期只导入图片，视频条直接从索引里过滤掉（因此列表页会出现「整页 0 条」的情况，走查逻辑必须容忍，见 Task 10）。

