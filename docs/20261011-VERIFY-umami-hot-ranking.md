> **ID**: VERIFY-003
> **性质**: 参考记录
> **状态**: 进行中
> **更新**: 2026-10-11
> **适用范围**: Umami path metrics采集、静态views数据与热度列表顺序
> **前提**: 只做本地验证；未触发 Pages 发布，也未在此验证运行时 Umami 账户凭据
> **依据**: [改进计划](20261011-PLAN-umami-hot-ranking.md)
> **关联**: [索引](00-索引.md)

# Umami 热度列表完整性验证

## 结论

旧采集只取 Umami `type=path` 查询的前1000条；当前 Umami API 文档说明 `limit` 为最大返回行数，并支持 `offset` 跳过行，因此旧逻辑存在超过1000条后漏采的可能。现已新增按offset分页，默认最多读取100000行；排序逻辑把所有有正浏览量的相册按views降序放在前面，零浏览量相册再随机排列。两部分在本地有自动化测试；线上效果需在下一次 Pages 发布后确认。

## 实施

- `scripts/umami-metrics.js` 执行limit/offset分页，短页结束，默认安全上限100000；触及上限时告警。
- `scripts/build-views.js` 限制单页1–1000，配置总行1–1000000，默认100000；30天窗口与累计全站`/stats`保持原行为。
- `public/hot-ranking.js` 将正views全排序、零/missing views传给原有确定性随机洗牌；前端缓存和分页流程未改。
- 热度数据仍由构建时拉取并作为静态数据发布，前端不访问Umami API。

## 验证命令与结果

- `npm run check`：通过。
- `npm run test:hot`：20/20通过，包含Umami分页、热度排序和会话客户端回归。
- `npm run test:search`：搜索19项、无效查询5项及Pages静态构建fixture通过；fixture覆盖根域和`/xrw-album/`路径，并确认hot-ranking.js随静态站点发布。
- `git diff --check`：待提交前执行。
- Pages workflow / 线上版本尚未发布核验；本次不执行会覆盖本地data/views.json或缺少snapshot的全量站点构建。
