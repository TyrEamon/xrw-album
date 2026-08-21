# XRW VPS Publisher

VPS 常驻发布端。它从 Veil 的图集列表发现任务，按单张图片保存 SQLite 断点，将图片转存到 Telegram Channel 图床，最后生成完整图集发布包并可选提交到 xrw-album 的私有管理接口。

## 为什么用 Go

- 可交叉编译成一个 Linux 二进制文件，VPS 不需要 Node/Python 运行环境。
- 常驻内存占用低，适合长期限速下载、重试和代理轮换。
- SQLite 使用纯 Go 驱动，不依赖 VPS 上的 CGO 或系统 SQLite 开发包。

## 数据边界

Telegram Channel 保存图片本体。VPS直接调用 Bot API 的 `sendMediaGroup` / `sendDocument`，随后把公开键、`file_id`、`file_unique_id`、`message_id` 和图集快照一起提交给管理 Worker。Worker 将映射写入 D1 的 `tg_files` 表；`album_details` 保存公开图片 URL、宽高和图集信息。Bot Token 不会进入网页 URL。

VPS 的本地 SQLite 会记录：

- 图集发现状态、源站更新时间、预期数量和失败原因。
- 每张源图片的顺序、宽高、TG公开URL和图床返回的TG标识。
- 图集详情返回的标签；发布时同步到 D1 的标签关系表，当前展示端不读取。
- `pending / incomplete / ready / ok / blocked` 等断点状态。
- 普通错误连续失败5次后进入 `failed` 隔离队列；运行 `retry-failed` 可在后续批量补录。

## TG 频道图床

创建 Bot、把它设为所有目标频道的管理员，然后配置 `TG_BOT_TOKEN` 与逗号分隔的 `TG_CHAT_IDS`（单频道仍兼容 `TG_CHAT_ID`）。新图集按源图集 ID 固定分配到一个频道，并把频道 ID 存入本地 SQLite；已有上传断点的历史图集会保留在列表第一个频道，不会在续传时跨频道。发布器把原文件按每10个一组发送；末尾2–9个仍是一组，只剩1个时使用单个 `sendDocument`。文件不会按照片模式压缩，也不经过 `telegra.ph/upload`。

每个图集第一组的第一个文件带频道说明，格式为 `#标签` 加 HTML 引用样式的图集名称；没有标签时只写图集名。后续文件组不重复说明。标签中的空格和标点会转换成下划线，重复标签会去掉。

每张图片使用稳定公开键 `veil-<source_image_id>`，最终展示地址形如：

```text
https://album.example.com/file/veil-1191867
```

管理接口的发布包同时包含 `photos` 与 `tg_files`。后者供 Worker 写入 D1 文件映射，示例：

```json
{
  "public_key": "veil-1191867",
  "url": "https://album.example.com/file/veil-1191867",
  "file_id": "telegram-file-id",
  "file_unique_id": "telegram-unique-id",
  "message_id": 123,
  "channel_id": "-1001234567890",
  "content_type": "image/jpeg"
}
```

展示 Worker 后续使用私密 Bot Token 调用 `getFile`，代理返回图片并做 Cloudflare Cache。不能把 Telegram 的临时下载地址直接写入 D1，因为地址含 Bot Token且不是永久链接。

D1 的 `tg_files` 只长期保存 `public_key / file_id / file_unique_id / message_id / content_type`。完整公开URL和相同的频道ID不会按图片重复落库；`album_details` 也使用紧凑格式保存图片路径、宽高和源图ID，由 Worker 对外返回时还原成原有JSON对象，以降低百万级数据量的占用。

## 配置

参考 [.env.example](./.env.example)。程序读取环境变量，不会主动读取 `.env` 文件；systemd 使用 `EnvironmentFile` 注入配置。

`VEIL_PROXIES` 填 SOCKS5 出口列表。VLESS、VMess、Trojan 客户端只需在 VPS 本地暴露 SOCKS5 端口，发布器不直接实现这些协议。每个代理拥有独立的限速时钟，默认按 `80 次 / 300 秒 / IP` 运行；403/429 后该出口冷却35分钟。

`TG_UPLOAD_INTERVAL=3500ms` 是每个频道各自的媒体组间隔；`TG_GLOBAL_INTERVAL=500ms` 控制同一个 Bot 的全局请求起始间隔，`TG_MAX_CONCURRENT=3` 限制同时上传数。每次请求最多包含10个文件。

标准 Telegram Bot API 的 `getFile` 下载上限是20MB，因此 `MAX_IMAGE_MB` 不能设得更大；否则频道虽然可能上传成功，展示 Worker 也无法把该文件取回。发布器会在上传前拦住超限图片，避免生成打不开的图集。

## 构建

在 `publisher` 目录执行：

```bash
go test ./...
go build -o bin/xrw-publisher ./cmd/xrw-publisher
```

Windows 上交叉编译 Linux amd64：

```powershell
$env:GOOS='linux'
$env:GOARCH='amd64'
$env:CGO_ENABLED='0'
go build -o bin/xrw-publisher-linux-amd64 ./cmd/xrw-publisher
```

## 首次运行

初始化数据库并查看状态：

```bash
./xrw-publisher status
```

扫描所有图集。接口每页100项，当前约需996次列表请求：

```bash
./xrw-publisher discover -pages 0
```

也可以从指定列表偏移量继续扫描，便于分段发现或恢复：

```bash
./xrw-publisher discover -pages 100 -offset 50000
```

列表中 `uploaded_images < image_count` 的图集会进入 `waiting`，不会反复请求尚未入库的图片。后续扫描发现源站已经上传完整时，它会自动转为 `pending`。

先试跑一个图集：

```bash
./xrw-publisher run -max 1
```

不配置 `XRW_ADMIN_URL` 时，完整图集进入：

```text
work/outbox/veil-<gallery_id>.json
work/outbox/veil-<gallery_id>.txt
```

状态为 `ready`，不会误报为已写入D1。配置管理接口后再次运行，会直接发布这些 `ready` 图集并改为 `ok`。

`status` 还会显示成功下载的源图片字节与成功上传的 Telegram 文件字节。VPS 账单口径应另外用 `vnstat` 或云厂商 NetworkIn/NetworkOut 指标确认：

```bash
vnstat
vnstat -d
vnstat -m
```

## 常驻运行

```bash
./xrw-publisher daemon -pages 5 -batch 0
```

每个周期扫描最新5页，然后把当前可处理队列持续跑空，再等待 `DISCOVERY_INTERVAL`。首次全量发现应单独执行一次 `discover -pages 0`。

部署模板见 [deploy/xrw-publisher.service](./deploy/xrw-publisher.service)。务必把 `/var/lib/xrw-publisher` 放在持久化磁盘上。

## GitHub Pages 增量快照

`snapshot` 命令只导出状态为 `ready / ok` 且自上次成功导出后发生变化的完整图集。配置 `GIMG_PUBLIC_BASE` 与 `GIMG_SIGNING_SECRET` 后，公开批次把 Telegram `file_id` 转成不可篡改的 `gimg` 签名地址；批次仍不包含原始 `file_id`。GitHub Pages 看图时由独立 `gimg` Worker 验签并取图，完全不查 D1：

```bash
./xrw-publisher snapshot -out /var/lib/xrw-publisher/github-snapshot/batches -max 1000
```

启用 `gimg` 后，旧快照需要一次性重导出，后续定时任务恢复增量模式：

```bash
./xrw-publisher snapshot -reset -out /var/lib/xrw-publisher/github-snapshot/batches -max 1000
```

若完整图集超过单批 `-max`，不要再次加 `-reset`，让后续定时运行继续导出剩余图集。仓库变量 `GIMG_PUBLIC_BASE` 只负责在Pages构建时把旧 Telegraph 地址改写为 `gimg` 反代；签名密钥只保存在VPS和Worker secret中，绝不放进GitHub仓库或快照。

配套的 `xrw-publisher-snapshot.timer` 每15分钟运行一次同步脚本；没有新增图集时不会产生提交。VPS只向 `snapshot` 分支追加脱敏批次，该分支推送不触发Pages。Pages工作流固定每3小时检出最新快照并部署，网站代码推送到 `main` 时仍会立即部署。

两套图片Worker相互独立：桌面的 `xrw-album-gimg-worker` 服务GitHub Pages，不绑定D1；仓库内 `cf-image-worker` 部署为 `xrw-album-cimg`，绑定现有D1并服务CF站。它们和根目录主站分别使用不同Worker名称，部署其中一个不会覆盖另外两个。

## VPS 与节点

建议使用 Linux x86_64、2 vCPU、2 GB 内存和40–60 GB SSD。发布器不会囤积全库图片，只保留当前批次、SQLite和日志；每组上传并写入断点后就删除临时原文件。单工作线程可在1 GB内存运行，但发布器和 sing-box/Xray 同机、同时开多个出口时，2 GB更稳。

发布器只接受 `socks5://` 或 `socks5h://`。VLESS、VMess、Trojan 链接交给 sing-box、Xray或mihomo，每个远端节点在本机监听一个独立SOCKS5端口，再填写：

```text
VEIL_PROXIES=socks5://127.0.0.1:10801,socks5://127.0.0.1:10802
```

轮换按这里的端口进行；只有远端出口IP不同才算不同的源站限速桶。多个本地端口最终落到同一个出口IP，不会增加可用额度。Telegram上传不走这些 Veil 代理，避免代理流量再消耗一遍。

## 完整性规则

- 图集使用稳定主键 `veil-<gallery_id>`。
- 用详情接口返回的图片列表验证 `image_id = cover_image_id + sort_order - 1`。
- 图片响应带 `x-gallery-id` 时必须与图集匹配；旧图片流不带该响应头时，以详情中的明确 image ID 为准。
- 每组文件上传成功后，在一个本地 SQLite 事务中保存该组所有单张断点，再删除临时图片。
- 图片数量、顺序和TG URL全部完整后才生成发布包。
- 新图集的每张图片必须有实际宽高，Worker 才接受发布；瀑布流会在下载前按该比例预留位置。
- Worker 用稳定图集ID去重；已是 `ok` 且源更新时间、预期数量、已发布数量都一致时，VPS直接跳过。
- 源图集改变时保留仍匹配的已上传图片，只重新处理变化部分。

若连续ID假设不成立，图集进入 `blocked`，不会误把相邻图集图片发布进去。
