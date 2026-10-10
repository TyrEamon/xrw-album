> **ID**: VERIFY-002
> **性质**: 参考记录
> **状态**: Worker 已发布观察模式；Pages 已提交并推送，Actions 状态及会话流程待验证
> **更新**: 2026-10-10
> **适用范围**: 本地 xrm-album 前端与 xrw-album-gimg-worker
> **前提**: 本地修改、仿真测试与实际观察模式 Worker 部署；未读取或复述 Cloudflare Secrets，未以已完成Turnstile挑战验证Siteverify
> **依据**: [会话实施计划](20261010-PLAN-gimg-session.md)
> **关联**: [索引](00-索引.md)、[旧令牌审计](<20261010-VERIFY-token-and-ant scraping.md>)

# GIMG 会话保护实施验证

## 结论

Turnstile 会话、图片缓存前验证、图片会话/IP 双层配额和公开 JSON 独立配额已部署到 Worker，当前 `observe` 模式只记录决策、不强制图片会话。线上 `/session` GET 返回 `authenticated:false, mode:observe`，HTTP 200。xrm 前端改动已推送 GitHub `main`（commit `ea5e29acdee977be34b14846342840adbd80ec7d`）；Pages 已返回新 HTML 版本 `app.js?v=20261010-session-1`，但检查时模块请求仍加载旧缓存版本，需等待/清除 GitHub Pages/浏览器缓存后再验证。

## 已运行验证（A 级）

工作目录：`D:\Desktop\绮影志\xrw-album-gimg-worker` 与 `D:\Desktop\绮影志\xrm-album`；Node.js 本机版本由 `node --version` 可复核。

- Worker：`npm run check` 通过；`npm test` 通过，42 tests / 42 pass / 0 fail。测试显式限定 `test/worker.test.js test/session.test.js`，不遍历无关 `GPT&Grok` 子树。
- 新增回归覆盖会话轮换共享IP配额：同一IP不同sid使用不同sid键、同IP键一致；任一IP桶拒绝时整体429。GET `/session` 使用独立状态桶；observe拒绝只记事件并仍返回状态，enforce 返回429。
- Worker打包及发布：Wrangler 4.125.0 dry-run成功；部署时首次因本地配置将远程路由误声明为custom domain且DNS由外部管理而失败，随后恢复为远程既有路由 `gimg.mtcacg.top/*`（zone `mtcacg.top`）再部署成功。当前版本 `a854cb77-cb47-4593-8e6f-dba4a0f04a5f`，绑定session10/min、status120/min、image600/min、JSON120/min、upstream180/min，`SESSION_MODE=observe`。`/session` 实际GET返回200与authenticated=false。
- 前端：`node --test test/gimg-session.test.js` 通过，14/14；`node scripts/test-pages-search.js` 通过，涵盖根路径和 `/xrw-album/` 路径的会话资源复制与版本化；`node --check public/app.js`、`node --check public/gimg-session.js`、`git diff --check` 通过。
- Pages静态构建：在相册仓库执行 `node scripts/build-gh-pages.js`，设置 `GITHUB_PAGES_BASE=/`、`GIMG_PUBLIC_BASE=https://gimg.mtcacg.top`、JSON回退地址及 1/2/3 数据源；生成 14973 个本地详情、416 个 shard，构建成功。缺少 `snapshot-data/batches`，因此该次构建的 Snapshot albums 为 0；不得用该本地产物发布替换线上数据。构建输出 `dist-gh-pages` 已被脚本覆写为本次本地验证产物。
- Pages：commit `ea5e29acdee977be34b14846342840adbd80ec7d` 已推送到 `main`。线上HTML读取已返回新版本号 `app.js?v=20261010-session-1`；浏览器检查仍读到旧版本 `20260918-3`，存在CDN/浏览器缓存或Actions未完成可能；Actions结果和浏览器模块加载需后续复核。

## 代码与接口要点（B 级）

- Worker `src/session.js` 使用 `GIMG_SESSION_SECRET`（至少32字符）签名独立随机sid，Turnstile Siteverify 校验 success、hostname、action；cookie 为 `__Host-gimg_session; Secure; HttpOnly; SameSite=Lax; Path=/`，TTL 3600 秒。
- `/tg`、`/telegraph` 在图片缓存读取前执行会话/配额和Telegram签名校验；共享 Worker Cache API 缓存保留，observe/enforce 客户端响应设为 private/no-store。HEAD 命中 GET 元数据，冷HEAD不写GET body缓存。
- 图片和回源配额分别以 `sid` 与边缘 IP 双键判定，任一失败即拒绝，避免重新完成人机验证轮换sid重置同IP预算。公开 JSON 不需要Turnstile，独立限额。GET `/session` 使用独立120/min状态查询桶；observe只记录，不拦截状态响应。
- `wrangler.jsonc` 保留 `workers_dev=true`；启用 enforce 前需检查该备用主机和其他入口，确认不会形成可绕过域名；Cookie是 gimg 主机的 host-only Cookie。
- 实际Pages浏览器仍加载旧版 app.js，故会话POST/cookie readback/原生图片携带cookie仍未验证。尚未进行一次成功的Turnstile挑战。
- 图片响应仍带既有 `Access-Control-Allow-Origin: *`。前端当前以原生 `<img>` 读图，不是带凭据 `fetch`；浏览器是否实际随跨站图片请求发送该 SameSite=Lax Cookie，必须用真实浏览器/线上部署验证。跨源 `/session` fetch 已设置 `credentials: include` 并有精确来源CORS。

## 生产发布门禁（待核实）

1. 确认Turnstile widget允许 `album.mtcacg.top` 且action为 `gimg_session`；Secret不应出现在仓库、日志或聊天记录中。
2. 已部署暂定namespace IDs 1001–1005；Wrangler 4.125.0未提供 `ratelimit list` 命令，本地无法独立核查账号级命名空间唯一性。
3. Worker observe已发布；检查workers.dev和备用路由、Cloudflare缓存规则，以及旧缓存策略。过去浏览器已缓存或下载的图片不可通过新会话撤回。
4. Pages新版本号已从线上HTML读到，等待Actions完成并验证页面实际加载新模块。
5. 真人浏览器确认会话POST、GET读回cookie、原生图片携带cookie、多标签、移动网络、JSON回退、续期和限流体验后，才由用户决定是否改为 `enforce`。回退：observe继续兼容；off恢复旧行为。
6. Cloudflare Rate Limiting binding是colo级近似预算、非精确全局额度。当前尚未完成Turnstile成功流程/原生图片跨站Cookie的端到端验证，未启用强制模式。
