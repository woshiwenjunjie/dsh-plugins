# dsh-plugins

我的 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai) Web 插件仓库：一个仓库集中维护多个插件，
每个插件是一个独立、可发布的 npm 包（DSH bundle），零构建、零运行时依赖。

## 插件

| 插件 | 说明 | 版本 | 文档 |
|---|---|---|---|
| **dsh-sticky-notes** | 左侧便签栏：随手记录、置顶、搜索、归档、5 秒撤销；数据只存本机 | `0.1.0` | [README](plugins/dsh-sticky-notes/README.md) · [CHANGELOG](plugins/dsh-sticky-notes/CHANGELOG.md) |

![dsh-sticky-notes](plugins/dsh-sticky-notes/docs/light.png)

## 快速开始

```bash
# 从 npm 安装（发布后）
dsh plugin --profile web add dsh-sticky-notes

# 本地开发 / 尚未发布时：直接链到子目录
dsh plugin --profile web add link:<仓库绝对路径>/plugins/dsh-sticky-notes
```

装好之后刷新页面即可。卸载用 `dsh plugin --profile web remove dsh-sticky-notes`，
也可以在 DSH 的「设置 → 插件」里管理。

## 目录结构

```
dsh-plugins/
├── plugins/
│   └── dsh-sticky-notes/     # 每个插件一个目录 = 一个可发布的包
│       ├── lib/              # index.js（宿主半侧）+ client.js（浏览器半侧，即产物）
│       ├── docs/             # README 用的截图
│       ├── test/             # 冒烟测试 + 预览生成
│       ├── cordis.patch.yml  # bundle 挂载声明
│       └── package.json      # 版本、市场元数据、dsh.bundle / dsh.client
├── scripts/check.mjs         # 全仓库校验（语法 + 每个插件的冒烟测试）
├── templates/plugin/         # 新插件骨架
├── docs/                     # 插件开发与发布指南 + ci-workflow.yml（CI 工作流）
```

## 启用 CI

`.github/workflows/` 下的文件需要带 `workflow` scope 的 GitHub token 才能推送，本仓库先把它放在
`docs/ci-workflow.yml`。启用只要三步：

```bash
gh auth refresh -s workflow          # 或换成有 workflow 权限的 token
mkdir -p .github/workflows
cp docs/ci-workflow.yml .github/workflows/ci.yml
git add .github/workflows/ci.yml && git commit -m "ci: 启用校验工作流" && git push
```

之后每次 push / PR 会在 Node 22 与 24 上跑 `node scripts/check.mjs`。

## 质量基线

每个插件在合入前都要过：

- `node scripts/check.mjs` —— 所有插件的 `lib/client.js` 语法检查 + 冒烟测试；
- 视觉用 `plugins/<name>/test/preview.mjs` 生成静态预览页核对（浅色 / 深色 / 收起态）；
- 交互变更在真实 DSH 页面里点过一遍。

现有插件都遵循同一套基线：颜色只走 DSH 主题 token、命中区 ≥ 24px、对比度达 WCAG AA、
面板不遮挡 DSH 自己的列、插件内部用错误边界兜底。

## 文档

- [docs/plugin-authoring.md](docs/plugin-authoring.md) —— DSH 客户端插件的加载机制、slot 注册、
  主题 token、左列边界测量等踩坑记录（写新插件前先读）。
- [docs/publishing.md](docs/publishing.md) —— 版本号、CHANGELOG、打 tag、发 npm、提交插件市场的流程。
- [CONTRIBUTING.md](CONTRIBUTING.md) —— 新增一个插件的清单（含模板用法）。

## 兼容性

本仓库插件在 **DSH `0.2.1-rc.2`**（桌面端 0.12.1）实测通过。DSH 迭代较快，升级后请重跑
`node scripts/check.mjs`，并在真实页面里确认 shell.overlay 的 occupant 仍为 active。

## English summary

A personal collection of DSH (DeepSeek Harness) web plugins, one directory per plugin,
each a publishable npm bundle with no build step and no runtime dependencies. The first
plugin is **dsh-sticky-notes**: a sticky-notes side panel that docks beside the session
list without covering it, with quick capture, pinning, search, archiving, a 5-second undo
and local-only storage (nothing leaves the browser). Guides for authoring and publishing
live in `docs/`.

## License

[MIT](LICENSE) © 2026 Maple (woshiwenjunjie)
