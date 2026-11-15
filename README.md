# Huabu · AI 图片无限画布

纯静态、零构建。运行：

```bash
python3 -m http.server 8000   # 然后打开 http://localhost:8000
```

- 注册即送 100 算力（演示账号，存在本机）。内置 Aurora / Prism 演示模型，无需 Key。
- 接真实模型：右上角头像 → 设置 → 模型接入，填 OpenAI 兼容接口（`/images/generations`、`/images/edits`）。
- 对接真实账号/收费后端：在 `index.html` 设置 `window.HUABU_CONFIG = { apiBase: 'https://…' }`，接口契约见 `docs/PLAN.md` §4。
- 方案：`docs/PLAN.md`　自审：`docs/REVIEW.md`
