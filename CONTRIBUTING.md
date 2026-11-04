# 贡献 / 新增插件

这个仓库的约定：**一个目录 = 一个可发布的包**。新插件请放在 `plugins/` 下，目录名等于
`package.json` 的 `name` 的最后一段（允许 scope：`@you/dsh-my-plugin` 放 `plugins/dsh-my-plugin`）。
`cordis.patch.yml` 的 `name:` 必须等于包名（市场按它把 entry 挂到安装的包上），`id:` 只需全局唯一。

## 新增一个插件

1. 复制骨架：

   ```bash
   cp -r templates/plugin plugins/dsh-my-plugin
   ```

2. 改 `plugins/dsh-my-plugin/package.json`：`name`、`version`（从 `0.1.0` 起）、
   `description`、`keywords`、`repository.directory`。
3. 写宿主半侧 `lib/index.js`（不需要 Host 能力时保持空插件即可）。
4. 写浏览器半侧 `lib/client.js`：普通脚本，`window.__ModuleLoader__.load({ id, factory })`，
   factory 返回 `{ name, inject, apply }`。**不要**用顶层 `import` / `export`。
5. 补 `test/smoke.mjs`（照 `plugins/dsh-sticky-notes/test/smoke.mjs` 抄一个，替换断言）；
   需要测交互就再加 `test/behavior.mjs`（迷你 React 的实现可以直接抄，见 `plugins/dsh-sticky-notes/test/behavior.mjs`）。
6. 补 `README.md`、`CHANGELOG.md`，截图放 `docs/`（浅色 + 深色至少各一张）。
7. 在根 `README.md` 的插件表里加一行。
8. 跑校验：

   ```bash
   node scripts/check.mjs        # 结构 + 语法 + 冒烟/行为/对比度，必须 0 退出
   node scripts/pack-check.mjs   # 打包自检：npm pack 出来的包里该有什么
   ```

## 提交信息

用 `<type>(<plugin>): <summary>` 的格式，方便按插件过滤历史：

```
feat(dsh-sticky-notes): 支持归档视图
fix(dsh-sticky-notes): 暗色主题下撤销条文字不可见
docs(dsh-plugins): 补充发布流程
chore(repo): 升级 CI Node 版本
```

## 合并前自检

- [ ] `node scripts/check.mjs` 与 `node scripts/pack-check.mjs` 都通过
- [ ] 新增交互有行为测试覆盖（改坏它，测试要能失败——先反验一次）
- [ ] 真实 DSH 页面里验证过（安装后点过一遍主要交互）
- [ ] 颜色只走主题 token；暗色主题单独看过
- [ ] 命中区 ≥ 24×24、文字对比度 ≥ 4.5:1（正文）
- [ ] 面板不遮挡 DSH 自己的列；不劫持页面滚动
- [ ] 数据只存本机、不新增网络请求；若必须请求，在 README 里写明
- [ ] `CHANGELOG.md` 有对应条目；版本号已按语义化版本调整

## 代码风格

- 2 空格缩进、LF、UTF-8，见 `.editorconfig`。
- 插件内不引入构建步骤：`lib/client.js` 就是发布产物，保持「可直接读的普通脚本」。
- 中文注释可以，但对外文案走 `ctx.locale` 字典（zh 为键集真源，en 对齐）。
