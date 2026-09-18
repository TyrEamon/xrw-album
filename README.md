# 墨影集

基于 `linuxdo-85w.txt` 构建的图片图集浏览站点，包含首页瀑布流、图集详情、点赞、搜索、随机/顺序浏览、全部图片瀑布流和窗口化渲染优化。

## 预览

- GitHub Pages 静态版：[https://hg3386628.github.io/xrw-album/](https://hg3386628.github.io/xrw-album/)
- Workers + D1：[https://xrw-album-workers.sexalbum.workers.dev](https://xrw-album-workers.sexalbum.workers.dev)

说明：GitHub Pages 静态版是只读镜像，点赞保存在浏览器本地；Workers 站使用 D1 数据与服务端点赞接口。

## 功能

- 黑色背景图片浏览界面
- 首页三个 tab：全部图片、最近更新、随机漫游
- 全部图片瀑布流默认随机，可切换顺序/随机
- 首页和详情页支持无限滚动与预加载
- 详情页支持 100%-300% 图片显示大小，本地持久化
- 相册搜索、点赞、相册详情页
- 大量图片场景下的窗口化渲染，减少 DOM、CPU 和内存占用

## 搜索图集

点击搜索框会展开简短提示；右侧筛选图标打开高级搜索表单，支持直接填写包含、短语、排除和标签条件。点击外部或按 Escape 收起，不占用日常浏览空间。

- `神楽坂真冬 护士`：标题必须同时包含两个关键词，顺序不限。`神楽坂真冬+护士` 也可。
- `"Bao Ji Shao Nu"`：标题连续包含这段文字；引号内的空格和 `+` 按原文匹配。
- `神楽坂真冬 -口罩`：标题包含前者、排除后者。
- `tag:护士`：只匹配完整标签，不会因标题含“护士”就命中。带空格的标签写作 `tag:"Bao Ji Shao Nu"`。
- 所有条件取交集，可组合使用；`-tag:Cosplay` 排除某个标签。暂不支持 OR。

GitHub Pages 仍只读取主仓库和外部数据仓库的 JSON，不查询 D1。Cloudflare 版使用相同规则生成绑定参数的 D1 查询；本地预览也使用同一解析器。新增模块 `public/search.js` 必须与前端一起发布；不修改数据、图片代理或爬虫流程。

搜索回归测试：`npm run test:search`（使用 Node 22.13+ 内置 SQLite，无需安装测试依赖）。

维护约定：沿用站内 Lucide SVG 和主题变量，不为一个筛选面板额外引入组件框架。输入法组合期间不发起搜索；输入一变化就使旧请求失效，避免慢响应覆盖新条件。移动端展开表单时收起长语法示例，保留可滚动面板和 44px 操作区域。CF 标签条件利用现有索引构造 ID 集合，避免逐图集执行关联标签子查询。

## 目录

```text
public/                 前端静态文件
server.js               当前 Node 生产服务
src/worker.js           Cloudflare Worker 入口
src/shared.js           Worker API 共享业务逻辑
data/albums.json        相册列表构建产物
data/photos/*.json      相册详情构建产物
data/manifest.json      数据集元信息
migrations/0001_init.sql D1 基础表结构
migrations/0002_publishing.sql 发布状态、TG文件映射和标签表
publisher/              Go 编写的 VPS 常驻发布端
scripts/build-data.js   从 linuxdo-85w.txt 构建数据
scripts/export-d1-sql.js 导出 D1 seed SQL
scripts/test-photos-api.js Node API 回归测试
scripts/test-worker-api.js Worker API 回归测试
wrangler.toml           Cloudflare Workers 配置
```

## 本地运行 Node 版本

```bash
npm install
npm run build:data
npm start
```

默认监听 `127.0.0.1:26785`，可通过 `PORT` 覆盖：

```bash
PORT=3000 npm start
```

## 检查

```bash
npm run check
npm run test:photos
npm run test:worker
npm run test:publish
```

## Cloudflare Workers + D1

Workers 版本使用 `public/` 作为 Static Assets，`src/worker.js` 提供 `/api/*`，D1 保存相册、详情和点赞数据。

### 生成 D1 数据

测试数据导出：

```bash
node scripts/export-d1-sql.js --limit=200 --out=data/d1-seed-test.sql
```

完整数据导出：

```bash
npm run export:d1
```

免费 D1 可按图集偏移分批导出，后续批次不会重写前面的图集：

```bash
node scripts/export-d1-sql.js --offset=0 --limit=5000 --out=data/d1-seed-00000.sql
node scripts/export-d1-sql.js --offset=5000 --limit=5000 --out=data/d1-seed-05000.sql
node scripts/export-d1-sql.js --offset=10000 --limit=5000 --out=data/d1-seed-10000.sql
```

默认导出的 SQL 使用 UPSERT，不会清空线上点赞或后来发布的图集，并兼容 D1 remote import。只有明确追加 `--reset` 才会生成清表语句；如果只用于本地 SQLite 调试，可以追加 `--transaction`。

### 部署流程

创建 D1：

```bash
npx wrangler d1 create xrw-album
```

把返回的 `database_id` 写入 `wrangler.toml`：

```toml
[[d1_databases]]
binding = "DB"
database_name = "xrw-album"
database_id = "..."
```

应用全部 D1 migrations，再导入测试数据：

```bash
npx wrangler d1 migrations apply xrw-album --remote
npx wrangler d1 execute xrw-album --file data/d1-seed-test.sql --remote
```

配置管理发布接口与 TG 文件代理所需的 Worker Secrets：

```bash
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put TG_BOT_TOKEN
```

`ADMIN_TOKEN` 与 VPS 上的 `XRW_ADMIN_TOKEN` 必须一致；`TG_BOT_TOKEN` 使用保存图片频道的同一个 Bot。不要把这两个值写进 `wrangler.toml` 或提交到仓库。

部署 Worker：

```bash
npx wrangler deploy
```

### 本地 Worker 验证

```bash
node scripts/export-d1-sql.js --limit=20 --out=data/d1-seed-test.sql
npx wrangler d1 migrations apply xrw-album --local
npx wrangler d1 execute xrw-album --local --file data/d1-seed-test.sql
npx wrangler dev --local --ip 127.0.0.1 --port 8787
```

打开 `http://127.0.0.1:8787`。

## 已验证

- `npm run check`
- `npm run test:photos`
- `npm run test:worker`
- `npm run test:publish`
- `npx wrangler deploy --dry-run`
- Workers 部署：`https://xrw-album-workers.sexalbum.workers.dev`

## 注意

- `data/d1-*.sql` 是生成文件，不入库。
- `data/likes.json` 是 Node 版本本地点赞文件，不入库。
- 免费D1导入完整旧数据时使用 `--offset` 与 `--limit` 分批执行，避免超过每日写入额度。
- 旧 85 万图片导入后标记为 `publish_status=ok`、`storage_provider=telegraph`、`mirror_status=pending`，会继续直接使用现有 Telegraph URL，不要求重新下载或上传。
- VPS 新图集只有在图片数量、TG 映射和宽高全部齐全后，才会通过 `/api/admin/sync/publish` 原子写成 `ok`。未完成任务只留在 VPS SQLite，不会出现在展示 API。
- Veil 标签写入 D1 的 `tags` 与 `album_tags` 表，为后续标签查询、排行榜或推荐接口保留；当前前端不会展示标签。
