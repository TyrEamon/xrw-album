> **ID**: VERIFY-001
> **性质**: 参考记录
> **状态**: 已运行验证
> **更新**: 2026-10-10
> **适用范围**: xrw-album 本地工作树、构建数据、公开数据样本与 gimg Worker
> **前提**: 本次审计不修改业务代码、不部署；反爬设计为待确认候选
> **依据**: 用户要求检查明文 Bot Token、85 万图片迁移及低误伤反爬
> **关联**: [索引](00-索引.md)

# 令牌与反爬审计

## A 级：已运行验证

- 本地项目 D:\Desktop\绮影志\xrm-album，HEAD d54e6ab7dfd1f83bc0df45b344f185b1584f682f。Git 跟踪文件 15029，加 dist-gh-pages/data 419，共 15448；扫描 15442 个文本文件，跳过 6 个含 NUL 的二进制，缺失 0。Bot Token 格式正则命中 0。正则：`(?<![A-Za-z0-9_-])\d{6,12}:[A-Za-z0-9_-]{30,}(?![A-Za-z0-9_-])`。这是当前工作树格式检查，非历史或所有编码形式的泄漏保证。
- 本地 data/photos 全部 14973 个 JSON 解析成功，photos 数组共 841140 条 URL 引用：839607 条主机为 telegra.ph，1533 条异常主机为 telegra.phhttps；gimg 与 Telegram API 类别均为 0。本地 dist 数据照片分类完全相同。这是旧本地/跟踪数据，非线上最终合并数据；数量未去重。异常示例为 data/photos/03qk-8eea5875d0.json 第 1 行。
- gimg 项目限定源代码、测试、配置等 7 个文本文件：明文 Bot Token 格式命中 0。排除无关 GPT&Grok 子树、node_modules 和 Git 数据库。
- 完整下载 xrw-data-1/main/batches/snapshot-20260901T070233.629362524Z-85209-85208.json：5358065 字符；Bot Token 格式 0，api.telegram.org bot URL 0，gimg.mtcacg.top/tg/ 出现 22899 次，telegra.ph/file/ 0。URL 出现次数包含封面，非去重照片数。该仓库仅此完整批次抽样，非全仓扫描。
- 线上 https://album.mtcacg.top/data/photo-shards/000.json 中旧相册 0000-c74f7797eb 的 29 张照片已为 gimg/tg URL；本地对应旧 JSON 为 Telegraph。证明这一相册的替换，不证明全部原始照片迁移。
- 线上公开图片一次无 Cookie、无 Referer 的 HEAD 请求返回 200、image/jpeg、Content-Length 368605、Cache-Control public,max-age=31536000,immutable。
- 在线 main manifest：builtAt 2026-10-10T09:47:09.705Z，albumCount 38504，photoCount 2151758，snapshotAlbumCount 38504。data-1 manifest：albumCount 23023，photoCount 1265779。数据重叠，禁止直接相加作为迁移总数。
- 本地 dist manifest：builtAt 2026-10-06T16:25:27.280Z，albumCount 14973，photoCount 841140，snapshotAlbumCount 0；sources=[]。属于旧构建，与当前线上不同。
- gimg 原有测试：在 D:\Desktop\绮影志\xrw-album-gimg-worker 执行 `node --test test/worker.test.js`，7 通过、0 失败。
- 纯内存 mock 验证：有效静态签名且无访客 Cookie 返回 200；缓存命中时附加 exp=1&sig=invalid、空 env 仍返回 200；两次 HEAD 引发 4 次 mock 上游请求。未对线上做负载测试。

## B 级：代码佐证

- [Worker 路由与缓存](../../xrw-album-gimg-worker/src/index.js#L33)：/tg、/telegraph 使用 cachedImage；/json 单独处理。59-75 行缓存命中早于签名验证，查询字符串从缓存键清除。HEAD 不使用此缓存。
- [Telegram 回源](../../xrw-album-gimg-worker/src/index.js#L77)：Bot Token 从 env 获取，getFile 与下载发生在服务端，返回图片流而非暴露含 Bot Token 的重定向。
- [签名逻辑](../../xrw-album-gimg-worker/src/index.js#L182)：base64url(file_id)+HMAC，未包含时间或访客绑定；是可转发的长期图片访问凭证，并非 Bot Token。HMAC 不隐藏 file_id。
- [前端](../public/app.js#L335)：明确的直连/回退逻辑是 JSON；图片按 photo.url 使用。838 行图片 no-referrer，因此空 Referer 拦截会伤及正常用户。
- [部署配置](../../xrw-album-gimg-worker/wrangler.jsonc#L8)：workers_dev=true，需确认实际部署并覆盖备用入口。
- [构建](../scripts/build-gh-pages.js)：本地旧数据叠加 snapshot 同 ID 覆盖；配置 GIMG 时也可把旧 Telegraph URL 改写为 /telegraph。存在 snapshot 和代理路径本身并不证明 Telegram 迁移完毕。

## 候选设计：待确认、未实施

目标是约束 gimg 资源消耗和批量抓取，而非承诺公开图片绝对防复制。

1. album 开橙云后对 HTML 导航使用风险挑战；不对图片/JSON 返回交互挑战 HTML。公开 GitHub 数据与 github.io 外部源仍可直接获取；只保护自定义域名不等于隐藏数据。
2. 在 album 页面完成 Turnstile，向 gimg POST /session 交换 HttpOnly、Secure、host-only 会话 Cookie。Worker 使用 Siteverify 校验 success、hostname、action；Turnstile token 单次使用且有效 300 秒，不逐张图片重复校验。会话建议先试 30-60 分钟。
3. /tg 与 /telegraph 的 GET/HEAD 每次先校验会话并限额，再查共享图片缓存；保留当前静态图片签名作为资源标识校验。JSON 代理独立限额。OPTIONS 只处理预检，不访问内容。
4. 请求链：会话校验 -> 会话/IP 风险及额度 -> 静态资源签名校验 -> 缓存 -> 受限回源。缓存命中也须受访问控制。前端收到过期或限流时统一续期/退避，避免每张图独立挑战。
5. 跨域 /session 与需带 Cookie 的 fetch 使用 credentials:include；响应仅允许 https://album.mtcacg.top 且 Access-Control-Allow-Credentials:true，按 Origin 正确隔离响应。当前 CORS * 不适合带凭据接口。使用 host-only gimg Cookie，避免扩大子域信任。
6. 先观察真实 p95/p99 行为，再启用会话令牌桶与 IP 辅助阈值。可试验会话突发 100-150 请求、补充 3-5 请求/秒，属于候选起点而非已验证生产阈值。前端每页 72 张并有封面预取，应容纳突发、多标签页及重试。持续枚举更多不同图片、长时高流量及回源量应另计预算。
7. HEAD 同样鉴权/限额，尽可能从缓存取元数据；限制回源并发和总预算，缓存 file_path 并在失效时重取。保护 workers.dev、自定义域与其他等价入口。
8. 边缘共享图片缓存可保留，浏览器/下游缓存策略单独设计；当前一年 public immutable 会允许已获取副本长期复用，撤销会话不能召回已下载图片。避免依赖仅在 cache miss 执行的签名或过期检查。
9. 首期推荐会话+限额，无需重写数百万 URL。后续若需要链接转发限制，可服务端签发绑定路径/期限/会话的短期票据，但签发端也要受额度控制。

## 验收门禁

- [ ] 无会话 GET/HEAD，无论缓存冷暖均按规则阻断；缓存热时过期会话仍失效。
- [ ] 正常首次进入一次验证，滚动、灯箱、切换相册和会话续期无破图风暴。
- [ ] JSON 直连失败回退成功；OPTIONS、跨域 Cookie 和 CORS 实测通过。
- [ ] 同 IP 多访客、移动网络切换、多标签页和快速滚动无明显误伤。
- [ ] 持续抓取与 HEAD 洪泛命中限额，上游调用量受控；备用入口不能绕过同等检查。
- [ ] 迁移核对：取得原始去重图片 ID 集合，与最终按构建规则合并数据和发送成功记录做差集；统计 pending/failed/Telegraph/缺失，核对目标频道记录，才判断 85 万全量迁移。

## 限制与资料

Git clone 多次连接失败；codeload 部分下载超时，未作为完整审计证据。未扫描 Git 历史、所有远程批次、线上 Worker 实际 Secrets、频道消息或完整迁移账本。没有发现格式匹配项并非保证所有秘密不存在。

- [Cloudflare DNS 代理状态](https://developers.cloudflare.com/dns/proxy-status/)
- [Challenge 页面与 API 限制](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/)
- [Turnstile 服务端验证](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
