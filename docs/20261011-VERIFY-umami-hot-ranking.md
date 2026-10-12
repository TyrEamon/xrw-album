> **ID**: VERIFY-003
> **性质**: 参考记录
> **状态**: 已运行验证
> **更新**: 2026-10-12
> **适用范围**: Umami path metrics采集、静态views数据与热度列表顺序
> **前提**: 已推送Pages主分支并核验GitHub Actions与线上静态资源；未在本次运行时独立验证Umami账户凭据
> **依据**: [改进计划](20261011-PLAN-umami-hot-ranking.md)
> **关联**: [索引](00-索引.md)

# Umami 热度列表完整性验证

## 结论

旧采集只取 Umami `type=path` 查询的前1000条；当前 Umami API 文档说明 `limit` 为最大返回行数，并支持 `offset` 跳过行，因此旧逻辑存在超过1000条后漏采的可能。现已新增按offset分页，默认最多读取100000行；排序逻辑把所有有正浏览量的相册按views降序放在前面，零浏览量相册再随机排列。本地测试通过，提交 `cba34f55aac0fc357679e720b61a865e0b9559f0` 已部署。GitHub Actions run 300成功；线上入口已载入新版app与hot-ranking模块。线上manifest builtAt=`2026-10-12T04:14:42.148Z`，albums=38506，其中views>0为64；直接调用线上排序模块确认正views降序、零views只在尾部。

## 实施

- `scripts/umami-metrics.js` 执行limit/offset分页，短页结束，默认安全上限100000；触及上限时告警。
- `scripts/build-views.js` 限制单页1–1000，配置总行1–1000000，默认100000；30天窗口与累计全站`/stats`保持原行为。
- `public/hot-ranking.js` 将正views全排序、零/missing views传给原有确定性随机洗牌；前端缓存和分页流程未改。
- 热度数据仍由构建时拉取并作为静态数据发布，前端不访问Umami API。

## 验证命令与结果

- `npm run check`：通过。
- `npm run test:hot`：20/20通过，包含Umami分页、热度排序和会话客户端回归。
- `npm run test:search`：搜索19项、无效查询5项及Pages静态构建fixture通过；fixture覆盖根域和`/xrw-album/`路径，并确认hot-ranking.js随静态站点发布。
- `git diff --check`：通过（提交前）。
- GitHub Actions run 300，commit `cba34f55aac0fc357679e720b61a865e0b9559f0`：Success；Pages部署任务成功。
- 线上 `https://album.mtcacg.top/` 返回200，HTML引用 `app.js?v=20261011-hot-all-1`；`hot-ranking.js?v=20261011-1` 返回200且含排序函数。
- 线上 `data/albums.json` 有38506项、64项views>0；`manifest.json builtAt=2026-10-12T04:14:42.148Z`。浏览器端以线上数据调用新排序函数，验证正views降序、零views位于尾部。
- 本次只验证了线上发布的静态views数据与排序模块，未单独观测Umami API新分页请求/凭据；下次常规构建才会应用新分页采集代码。不执行本地全站构建以免用缺失snapshot或陈旧数据覆盖产物。
