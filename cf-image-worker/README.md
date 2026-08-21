# XRW Cloudflare/D1 image Worker

仅供CF主站使用的独立图片Worker。它绑定主站现有D1，通过 `/file/<public_key>` 查询 `tg_files`，再由服务端调用Telegram Bot API取图。成功响应写入Cloudflare Cache API；命中缓存时不读取D1，也不请求Telegram。

它和仓库根目录的主站Worker是两个独立服务：

```text
根目录 wrangler.toml                 -> xrw-album-workers
cf-image-worker/wrangler.jsonc       -> xrw-album-cimg
```

在本目录执行命令只会部署 `xrw-album-cimg`，不会覆盖根目录主站。

## 部署

必须登录拥有 `xrw-album` D1 的同一个Cloudflare账户：

```powershell
cd cf-image-worker
npm install --cache .npm-cache
npm run check
npm test
npx wrangler login
npx wrangler secret put TG_BOT_TOKEN
npm run deploy
```

先通过 `xrw-album-cimg.<account>.workers.dev/health` 验证，再在Worker设置中添加Custom Domain，例如 `cimg.example.com`。不要把域名同时绑定到根目录主站Worker。

`cimg` 域名必须经过Cloudflare代理；灰云DNS不会执行Worker，也就无法查D1或反代Telegram。

VPS向D1发布时，把 `IMAGE_PUBLIC_BASE` 设置为最终的 `https://cimg.example.com`。已经写入D1的旧图片URL可以后续按前缀批量更新；`tg_files.public_key` 和映射本身无需改变。
