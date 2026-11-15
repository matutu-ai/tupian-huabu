# Huabu · AI 图片无限画布

## 两种运行方式

**A. 演示（纯静态，账号/算力存在浏览器，不可用于收费）**
```bash
python3 -m http.server 8000     # http://localhost:8000
```

**B. 正式（服务端：登录、算力、出图代理、支付回调）— 需要 Node ≥ 22.5，零依赖**
```bash
ALLOW_DEMO_TOPUP=1 node server/server.js     # http://localhost:8000 （ALLOW_DEMO_TOPUP 仅本地调试）
```
服务端同时托管前端；余额与扣费都在服务端 SQLite 里，用户改不了。

## 接你的生成模型（服务端，Key 不进浏览器）
只提供一个模型时：`server/models.json` 里只留一项，前端会自动隐藏模型选择器。把默认的 `mock` 条目替换成你的，例如：
```json
{ "id": "gpt-image", "name": "GPT Image", "desc": "OpenAI", "cost": 8,
  "type": "openai", "baseUrl": "https://api.openai.com/v1", "model": "gpt-image-1", "apiKeyEnv": "OPENAI_KEY" }
```
然后 `OPENAI_KEY=sk-... node server/server.js`。`cost` 就是每张收取的算力，定价自行决定。
（演示模式下也可在 设置 → 模型接入 里填 Key，仅限个人调试。）

## 下载
生成的图片可一键保存到用户本地（统一转为 PNG）：图片上方工具栏「下载」、顶栏下载按钮或 `Ctrl+S`（选中几张下几张，没选则下载全部；多张自动打包为 zip），也可在头像菜单「下载本画布全部图片」。

## 收费
- 套餐在 `server/server.js` 的 `PACKS` 与 `src/auth.js` 的 `PACKS`（两处保持一致）。
- 对接支付：设置 `PAY_URL_TEMPLATE`（收银台地址）和 `PAY_WEBHOOK_SECRET`；支付成功后让网关/你的支付服务 `POST /api/billing/webhook`，body `{"orderId":"…","status":"paid"}`，头 `x-signature` 为 body 的 HMAC-SHA256(hex)。回调幂等，重复通知不会重复加款。
- 人工加减算力：`node server/admin.js grant 用户邮箱 数量 [备注]`

## 上线前清单
1. 放在 HTTPS 反向代理（Nginx/Caddy）后面；设置 `ALLOW_DEMO_TOPUP` 为空。
2. 备份 `server/data.db`（SQLite）。
3. 对接真实支付通道（微信/支付宝/Stripe 均可，只需能回调 webhook）。
4. 生成图片目前以内联形式存在浏览器项目里；用户量大后改对象存储（见 docs/REVIEW.md）。

文档：`docs/PLAN.md` 方案 · `docs/REVIEW.md` 审查与遗留项
