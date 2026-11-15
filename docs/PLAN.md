# 图片画布（Huabu）方案

## 1. 对标分析

| 产品 | 值得借鉴 | 我们的取舍 |
|---|---|---|
| LibTV / Lovart 类 AI 画布 | 无限画布 + 底部悬浮提示词坞；生成结果即节点；选中图作为参考图继续生成；节点间连线表达“来源” | 全部采用；连线表示参考关系 |
| Figma / FigJam | 点阵网格、缩放/抓手手感、浮动工具栏、小地图、快捷键体系 | 采用 V/H/T、空格抓手、Ctrl+滚轮缩放、小地图 |
| Midjourney / 即梦 | 一次多张、比例选择、变体 | 采用：1–4 张、7 种比例、“变体” |

设计原则：**越简单越好**——画布占满全屏，所有控件是半透明浮层；只有一个主入口（底部提示词坞）。

## 2. 范围（本期）

- 无限画布：平移、缩放（0.1×–4×）、框选、多选、拖动、缩放节点、撤销/重做、复制粘贴、小地图、适应屏幕
- 节点：图片（生成/上传/粘贴/拖入）、便签
- 生成：提示词 + 模型 + 比例 + 张数；选中图片自动作为参考图；占位骨架 + 进度；失败自动退还算力
- 模型接入：内置演示模型（无需 Key，程序化出图）+ 自定义 OpenAI 兼容 `/images/generations`、`/images/edits`
- 账号与算力：注册/登录；每账号算力余额、流水；生成前预扣、失败退还；充值入口
- 项目：多项目、自动保存（IndexedDB）、单图下载、导出项目 JSON
- 外观：深/浅色主题，全中文

## 3. 架构

纯静态、零构建（ES Modules），便于直接部署与二次开发：

```
index.html        结构
src/styles.css    设计令牌 + 全部样式
src/icons.js      内联 SVG 图标
src/db.js         IndexedDB 封装（项目存储）
src/auth.js       账号/算力适配器：LocalAdapter（演示）与 RemoteAdapter（对接后端）
src/providers.js  模型列表 + 出图适配器（mock / openai-images）
src/app.js        画布引擎 + UI
```

关键点：
- 画布用 DOM（非 Canvas）渲染节点：图片清晰、文本可编辑、事件简单；世界层整体 `transform`，节点数量在数百级别内性能足够。
- 状态 = `nodes[] + view`；撤销用浅拷贝快照（图片 dataURL 以引用共享，不复制）。
- `auth.js` 对外只暴露统一接口，换后端只需切换适配器。

## 4. 后端对接契约（收费必须由后端兜底）

> **重要**：纯前端账号只能用于演示——余额存在浏览器里，用户自己可以改。真正收费时，登录、余额扣减、调用上游模型必须放在服务端，Key 也不能放浏览器。

**已实现**于 `server/server.js`（`config.js` 被服务端覆盖为 `apiBase:"/api"` 即切换到服务端模式）。接口：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/auth/register` `{email,password,name}` | 返回 `{token,user}` |
| POST | `/auth/login` `{email,password}` | 返回 `{token,user}` |
| GET | `/me` | 返回 `{user:{id,email,name,credits}}` |
| GET | `/credits/ledger` | 返回 `{items:[{ts,delta,note}]}` |
| POST | `/credits/spend` `{amount,note}` | 返回 `{credits}`，余额不足 402 |
| POST | `/credits/refund` `{amount,note}` | 返回 `{credits}` |
| POST | `/billing/checkout` `{packId}` | 返回 `{url}` 跳转支付 |

另有 `GET /models`、`POST /generate`（服务端先扣费、调用上游、失败退还）、`POST /billing/webhook`（HMAC 签名、幂等入账）。服务端模式下前端不再自行扣费。

## 5. 验收清单

见 `docs/REVIEW.md`（实现后自审记录）。
