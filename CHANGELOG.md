# Changelog · dsh-plugins

仓库级变更（新增插件、基建、CI）。每个插件自己的变更见 `plugins/<name>/CHANGELOG.md`。

## [0.1.0] - 2026-11-04

### 新增

- 仓库初始化：单仓多插件结构（`plugins/<name>/` = 一个可发布 bundle 包）。
- 第一个插件 **dsh-sticky-notes `0.1.0`**：DSH Web 左侧便签栏。
- 校验脚本 `scripts/check.mjs`：包结构检查 + `client.js` 语法检查 + 每个插件的冒烟测试。
- GitHub Actions CI（`.github/workflows/ci.yml`）：push / PR 在 Node 22/24 上跑同一套校验。
- 文档：`docs/plugin-authoring.md`（插件机制与踩坑）、`docs/publishing.md`（发版与上架流程）、
  `CONTRIBUTING.md`（新增插件清单）。
- 插件骨架 `templates/plugin/`：新插件的起点。
