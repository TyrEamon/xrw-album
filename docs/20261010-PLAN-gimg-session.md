> **ID**: PLAN-001
> **性质**: 工作稿
> **状态**: 进行中
> **更新**: 2026-10-10
> **适用范围**: 相册前端与相邻 gimg Worker
> **前提**: 用户已选会话反爬方案，截图确认新增 Secret 名称存在；值与线上有效性仍待核实。兼容优先，不自动开启强制模式。
> **依据**: [审计](<20261010-VERIFY-token-and-ant scraping.md>)
> **关联**: [索引](00-索引.md)

# 会话保护实施与接口合同

## 用户确认和边界

- 用户确认实施方案并在 Cloudflare 配置 GIMG_SESSION_SECRET、TURNSTILE_SECRET_KEY。截图只证明名称与加密状态，非密钥有效性。
- 公开 Site Key：0x4AAAAAAFTJSOtoMzTQgkm3。秘密不得提交到代码、报告或测试。
- 保留原 TG_BOT_TOKEN 和两个图片签名密钥。先 observe、后前端联调、最后用户启用 enforce；紧急回滚 SESSION_MODE=off。
- 本地未跟踪 OTC_SCAN_IPV4_AS932.txt 和 OTC_SCAN_IPV6_AS932.txt 为既有用户文件，排除。

## 冻结接口

- GET https://gimg.mtcacg.top/session，credentials:include，返回 `{ok:true, authenticated:boolean, expiresAt:epoch_seconds_or_null, mode:"off"|"observe"|"enforce"}`。
- POST 同一路径，Content-Type application/json，body `{token}`；仅相册 Origin。服务端 Siteverify 检查 success、hostname=album.mtcacg.top、action=gimg_session。
- 成功签发 host-only `__Host-gimg_session`，Secure、HttpOnly、SameSite=Lax、Path=/，候选 TTL 3600 秒。载荷含随机 sid、签发/到期时间并用独立会话密钥 HMAC 签名。
- /session 精确来源 CORS + credentials + no-store。错误返回 JSON，429 带 Retry-After；响应不得暴露秘密或上游含凭据 URL。
- /tg、/telegraph GET/HEAD enforce 时先检查会话/额度再查缓存；图片签名在缓存前验证。共享内部图片缓存与面向浏览器缓存策略分离。
- /json 保留公开回退，独立额度；不得给其返回挑战 HTML。
- 可靠限流通过平台绑定实现，禁止使用 isolate 内存计数冒充跨请求配额。平台本地限流的地域范围必须如实记录。
- 前端 session single-flight；observe/off/旧后端404保持兼容；enforce 在加载受保护图前验证。续期、失败重试有界，保留懒加载。

## 实施任务

- [x] 读取现有源码、部署工作流与工作树状态。
- [x] Worker 会话接口、缓存前鉴权、HEAD 缓存、限流和单元测试。
- [x] 相册 Turnstile 面板、会话协调、续期、有限重试与单元测试。
- [x] 修正会话轮换可重置sid额度：图片与回源分别要求sid桶和IP桶均放行；GET /session 独立宽松状态查询桶（observe仅记录，enforce才限流）。
- [x] 集成测试、静态构建检查与部署交接记录；真人浏览器/线上校验保留为生产门禁。

## 验收与发布门禁

1. node 单元测试覆盖冷/热缓存、伪造/过期会话、错误 hostname/action、Origin、HEAD、限额、observe 兼容。
2. 前端测试覆盖单请求合并、到期、错误退避、旧后端、JSON 回退与图片加载时序。
3. 构建使用测试输出或独立目录，禁止把本地缺失 snapshot 的旧数据发布覆盖线上。
4. Worker observe 先部署，再发布前端；真人完成 Turnstile 并验证滚动、灯箱、多标签、移动网络、JSON回退后才开启 enforce。
5. 本次缺少浏览器真人挑战通过结果时，明确保留为待核实，不宣称线上防护完成。
