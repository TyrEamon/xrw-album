> **ID**: VERIFY-004
> **性质**: 参考记录
> **状态**: 已运行验证
> **更新**: 2026-10-16
> **适用范围**: 首页/标签页/图集页右下角回顶按钮的行为与图标
> **前提**: 已推送 Pages 主分支并核验线上静态资源版本；未做全新无痕首访的 Turnstile 人工复测
> **依据**: 用户反馈「搜索后往下滑想快速回顶，但不想清空搜索」
> **关联**: [索引](00-索引.md)

# 回顶按钮恢复为纯回顶验证

## 结论

回顶按钮此前从未被删除，但它在首页搜索态（`/` 且 URL 带 `q` 或 `tag`）下会切换成「清除搜索回首页」的第二形态，图标为 lucide `search-x`、配色取 `--accent`，因此看起来像被换掉。按用户要求，该双形态已移除：按钮现在恒为 `arrow-up` 箭头，点击只滚动到顶部，不清空搜索条件。

## 背景与证据（改动前）

- `public/app.js` 中 `backToTopButton()`、`bindBackToTop()`、`syncBackToTop()` 通过 `isHomeSearchActive()` 判定形态；首页 `public/app.js:1213`、图集页 `:1394`、标签页 `:2642` 三处渲染同一按钮。
- 触发路径：点标签会 `navigate('/?tag=…')`（`public/app.js:1415`、`:2667`），搜索框提交会写 `?q=`（`:1705-1710`）。
- 线上 `app.js?v=20261011-hot-all-1` 中 `back-to-top` 出现 4 次、`data-back-to-top` 3 次，与本地源码一致，可排除「线上产物缺按钮」。
- 该双形态来自提交 `6ad4ad4c`「Add one-click return to clean home via logo and back-to-top button」（2026-10-07）。

## 变更

- `public/app.js`：`backToTopButton()` 恒输出 `class="back-to-top" data-back-to-top aria-label="回到顶部"` 与 `icons.up`；`bindBackToTop()` 点击只调用 `scrollPageToTop()`；`syncBackToTop()` 只维护 `is-visible`；删除 `isHomeSearchActive()`、`icons.clearSearch`、搜索提交后的 `syncBackToTop()` 调用。
- `public/styles.css`：删除 `.back-to-top.is-clear-search` 规则。
- `public/index.html`：资源版本递增为 `app.js?v=20261016-back-to-top-1`、`styles.css?v=20261016-back-to-top-1`。
- 清空搜索仍可用：左上角品牌区 `data-brand-home` 事件委托执行 `navigate("/")`（`public/app.js:3100-3107`），搜索框本身也可直接改词。

## 验证

- `npm run check`：通过。
- `npm run test:hot`：20/20 通过。
- `npm run test:search`：搜索 19 项 + 无效查询 5 项通过；Pages 静态构建 fixture 通过。
- `scripts/test-pages-search.js` 新增断言：构建产物含 `class="back-to-top" data-back-to-top aria-label="回到顶部"`，且不再包含 `is-clear-search`，防止双形态回归。

## 影响与回滚

- 影响面：首页、标签页、图集页右下角按钮的图标与点击行为；不涉及数据、构建流程与 Worker。
- 代价：搜索态下需要先滚到顶部才能点到品牌区回首页，或直接清空搜索框；换来的是搜索过程中始终保留「一键回顶」。
- 回滚：`git revert` 对应提交即可恢复 `6ad4ad4c` 的双形态。
