> **ID**: PLAN-002
> **性质**: 工作稿
> **状态**: 已完成
> **更新**: 2026-10-12
> **适用范围**: xrm-album 静态 Pages 构建的 Umami 图包热度采集与前端排序
> **前提**: 在线站点已有用户；兼容原数据结构和随机尾部；发布需用户明确指示
> **依据**: 用户提出完善热度推荐；Umami API 当前文档说明 metrics 支持 limit 与 offset
> **关联**: [验证记录](20261011-VERIFY-umami-hot-ranking.md)、[索引](00-索引.md)

# Umami 热度推荐完整性改进

## 决定

- `/album/<id>` 路径指标窗口维持最近30天；全站累计 visitors/pageviews 继续使用原 `/stats`。
- `GET /api/websites/{websiteId}/metrics` 以 limit/offset 翻页，单页最大1000，默认最大采集100000行；若触及总行上限输出警告并保留部分数据，避免无限请求。可用 `UMAMI_PATH_LIMIT`（1–1000）和 `UMAMI_MAX_PATH_ROWS`（至少一页、至多1000000）调节。
- 热度模式展示排序改为所有有正浏览量的图包按 views 降序（同量按 id 稳定排序），全部零浏览量图包仍随机排在后面。分页/首屏只会读取此排序的一段，不再把有热度的数据随机混在后段。
- 保持只在构建期使用 Umami share token；浏览器继续读静态 album.views，不引入客户端 Umami API 请求。
- 提交 `cba34f55aac0fc357679e720b61a865e0b9559f0` 已由用户指示发布；Pages部署成功。新分页采集代码将在下一次正常构建时生成对应静态数据。

## 验收

- metrics pagination 单测覆盖offset推进、短页结束、上限告警、非数组响应失败。
- hot ranking 单测证明所有正views均排序在前、零views仅进入洗牌尾部。
- Pages fixture 检查版本资源与新 module 被复制到输出；项目语法/原有测试保持通过。
- 构建产物的浏览量仍是近30天 Umami 路径页访问量，采集频率仍由现有 Pages schedule 决定，且受 Umami ingestion lag 影响。
