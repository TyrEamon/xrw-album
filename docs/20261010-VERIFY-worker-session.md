> **ID**: VERIFY-002
> **性质**: 参考记录
> **状态**: 已运行验证；生产真人浏览器验证待核实
> **更新**: 2026-10-10
> **适用范围**: 本地 xrm-album 前端与 xrw-album-gimg-worker
> **前提**: 仅本地修改和仿真测试；未部署、未读取 Cloudflare Secrets、未调用线上 Siteverify
> **依据**: [会话实施计划](20261010-PLAN-gimg-session.md)
> **关联**: [索引](00-索引.md)、[旧令牌审计](<20261010-VERIFY-token-and-ant scraping.md>)

# GIMG 会话保护实施验证

## 结论

本地已实现 Turnstile 换发 1 小时 HttpOnly 会话、图片缓存前验证、图片会话/IP 双层配额、独立公开 JSON 配额和状态查询限额。默认配置为 `observe`：图片浏览保持兼容，日志只记类别；只有切到 `enforce` 才执行图片会话门禁。此报告不代表线上已经启用。

## 已运行验证（A 级）

工作目录：`D:\Desktop\绮影志\xrw-album-gimg-worker` 与 `D:\Desktop\绮影志\xrm-album`；Node.js 本机版本由 `node --version` 可复核。

- Worker：`npm run check` 通过；`npm test` 通过，42 tests / 42 pass / 0 fail。测试显式限定 `test/worker.test.js test/session.test.js`，不遍历无关 `GPT&Grok` 子树。
- 新增回归覆盖会话轮换共享IP配额：同一IP不同sid使用不同sid键、同IP键一致；任一IP桶拒绝时整体429。GET `/session` 使用独立状态桶；observe拒绝只记事件并仍返回状态，enforce 返回429。
- Worker打包：`npx wrangler deploy --dry-run` 使用 Wrangler 4.125.0 成功，bundle 21.65 KiB（gzip 6.15 KiB）；显示 session 10/min、status 120/min、image 600/min、JSON 120/min、upstream 180/min 绑定及 `SESSION_MODE=observe`。未部署。
- 前端：`node --test test/gimg-session.test.js` 通过，14/14；`node scripts/test-pages-search.js` 通过，涵盖根路径和 `/xrw-album/` 路径的会话资源复制与版本化；`node --check public/app.js`、`node --check public/gimg-session.js`、`git diff --check` 通过。
- Pages静态构建：在相册仓库执行 `node scripts/build-gh-pages.js`，设置 `GITHUB_PAGES_BASE=/`、`GIMG_PUBLIC_BASE=https://gimg.mtcacg.top`、JSON回退地址及 1/2/3 数据源；生成 14973 个本地详情、416 个 shard，构建成功。缺少 `snapshot-data/batches`，因此该次构建的 Snapshot albums 为 0；不得用该本地产物发布替换线上数据。构建输出 `dist-gh-pages` 已被脚本覆写为本次本地验证产物。
- 页面工作流 `.github/workflows/deploy-pages.yml` 在上传 Pages artifact 前运行会话单测和静态 Pages fixture 检查；只有提交/运行 workflow 才会产生线上影响，本次未触发。

## 代码与接口要点（B 级）

- Worker `src/session.js` 使用 `GIMG_SESSION_SECRET`（至少32字符）签名独立随机sid，Turnstile Siteverify 校验 success、hostname、action；cookie 为 `__Host-gimg_session; Secure; HttpOnly; SameSite=Lax; Path=/`，TTL 3600 秒。
- `/tg`、`/telegraph` 在图片缓存读取前执行会话/配额和Telegram签名校验；共享 Worker Cache API 缓存保留，observe/enforce 客户端响应设为 private/no-store。HEAD 命中 GET 元数据，冷HEAD不写GET body缓存。
- 图片和回源配额分别以 `sid` 与边缘 IP 双键判定，任一失败即拒绝，避免重新完成人机验证轮换sid重置同IP预算。公开 JSON 不需要Turnstile，独立限额。GET `/session` 使用独立120/min状态查询桶；observe只记录，不拦截状态响应。
- `wrangler.jsonc` 保留 `workers_dev=true`；启用 enforce 前需检查该备用主机和其他入口，确认不会形成可绕过域名；Cookie是 gimg 主机的 host-only Cookie。
- 图片响应仍带既有 `Access-Control-Allow-Origin: *`。前端当前以原生 `<img>` 读图，不是带凭据 `fetch`；浏览器是否实际随跨站图片请求发送该 SameSite=Lax Cookie，必须用真实浏览器/线上部署验证。跨源 `/session` fetch 已设置 `credentials: include` 并有精确来源CORS。

## 生产发布门禁（待核实）

1. 核对截图中 Secret 名称对应的线上值已正确配置；不得把 Secret 写入仓库或日志。确认 Turnstile widget 允许 `album.mtcacg.top`、action 为 `gimg_session`。
2. namespace ID 1001–1005 是暂定值，部署前检查 Cloudflare 账户范围内唯一性与目标环境绑定。
3. 先部署 Worker `observe` 并确认应用日志、CF平台请求日志脱敏及配额观测；再更新 Pages 前端。检查 workers.dev/其他备用入口及 Cache Rules，保证受保护域名流量经过本Worker。
4. 真人浏览器确认会话POST后GET读回cookie、原生图片携带cookie、翻页/滚动/灯箱、多标签页、移动网络、JSON回退均正常；验证图片CORS与缓存命中、过期续期、限流体验。
5. 检查 legacy edge cache 与浏览器缓存策略；过去被浏览器缓存或下载的公开图不可由新会话撤回。只有业务方手动确认上述门禁后再将 `SESSION_MODE` 改为 `enforce`。回退先切回 `observe`，紧急恢复旧行为切 `off`；修改/部署操作均不属于本次任务。
6. 当前限制：Cloudflare Rate Limiting binding 以 colo 级近似配额运行，不是精确全局预算；需从真实流量调校阈值。真人浏览器和生产配置/路由/缓存尚未验证。
