# 发版与上架流程

这份文档固定本仓库的发布动作，目标是：**任何一次发布都能复现、能回滚、能被市场接受**。

## 1. 版本号

每个插件独立遵循 [语义化版本](https://semver.org/lang/zh-CN/)：

| 变化 | 版本位 | 例子 |
|---|---|---|
| 不兼容的界面/数据变更 | major | 数据迁移、删除字段 |
| 向下兼容的新功能 | minor | 新增归档、搜索 |
| 向下兼容的修复 | patch | 对比度修复、错别字 |

- 数据格式变化要在 `CHANGELOG` 与 README 的「数据存在哪」里写清兼容策略（本仓库的做法是
  新字段给默认值、旧数据可直接读）。
- 仓库根 `package.json` 的版本只做仓库标记，不参与插件版本。
- 兼容性声明 `dsh.compatibility.dshReleases` **只写实测过的 DSH 版本**；声称兼容却没好处的版本，
  出问题时会变成你自己的维护负担。

## 2. 发布前检查

```bash
node scripts/check.mjs                 # 结构 + 语法 + 冒烟 + 行为 + 对比度，必须 0 退出
node scripts/pack-check.mjs --list     # npm pack 自检：包里该有的都有、不该进包的一件没混进去
node plugins/<name>/test/preview.mjs   # 生成预览页，浅色/深色各看一眼
```

`pack-check` 检查的是 **tarball**，`check` 检查的是源码树——两者的差异（漏了 `lib`、
`test/` 混进去、icon 超 256KiB、`cordis.patch.yml` 的 `id` 与包名不一致或带行尾注释）
只有打包才暴露。它还会把包解开，确认 `exports["./client"]` 指向的文件真的在里面。
CI 里有一个独立的 `pack` job 跑它（见 `.github/workflows/ci.yml`）。

再在真实 DSH 里走一遍（这是唯一能验证「装进去能不渲染」的环节）：

```bash
dsh plugin --profile web remove <name>
dsh plugin --profile web add link:<绝对路径>/plugins/<name>
```

确认三件事：左边缘/入口出现、主要交互可用、浏览器控制台没有报错。

## 3. CHANGELOG 与 tag

1. 更新 `plugins/<name>/CHANGELOG.md`（`## [x.y.z] - YYYY-MM-DD` + 分类条目）。
2. 更新插件 `README.md` 里与版本相关的描述（截图、功能表）。
3. 提交并打 tag（仓库用「插件名@版本」的形式，多插件不会串）：

   ```bash
   git add -A
   git commit -m "release(<name>): v<x.y.z>"
   git tag <name>@<x.y.z>
   git push origin main --tags
   gh release create <name>@<x.y.z> --title "<name> v<x.y.z>" --notes-file <(sed -n '/## \[<x.y.z>\]/,/^## \[/p' plugins/<name>/CHANGELOG.md)
   ```

## 4. 发布到 npm

市场安装依赖 npm 包名（`dsh plugin --profile web add <pkg>`），所以先发布：

```bash
npm login                              # 只需一次；CI/自动化用 granular token
cd plugins/<name>
npm publish --access public
```

### 包名冲突怎么办

npm 的包名是全球唯一的。发布前先查，别等 `npm publish` 报错：

```bash
npm view <name> version                # 有输出 = 已被占用
npm view <name> maintainers description time.modified   # 看看是谁、是什么
```

被占用时**用带 scope 的包名**（`@你的账号/dsh-xxx`），代价很小：

- `package.json` 的 `name` 改成带 scope 的；
- `cordis.patch.yml` 的 **`name:` 必须跟着改成同一个字符串**（带 `@` 开头在 YAML 里要加引号）——
  市场是按 `name` 把 entry 挂到「安装的包」上的（判定规则是 `name === 包名 || name.startsWith(包名 + '/')`，
  见 `dshmarket/lib/entry-identity.js`）；
- `id:` **不用改**，它只需要在自己的 profile 里全局唯一（市场会查重复 entry id）；
- 目录名保持不带 scope 即可，`scripts/check.mjs` 允许 `@scope/<目录名>`。

本仓库的 `dsh-sticky-notes` 就撞过这个坑（`dsh-sticky-notes` 已被另一位作者占用，同名同概念），
最终用 `@woshiwenjunjie/dsh-sticky-notes` 发布。

### 发布后自查

不用等别人反馈：

```bash
npm view <pkg> version dist.tarball    # 版本与产物地址
npm view <pkg> dsh                     # dsh.bundle / dsh.client 元数据还在
dsh plugin --profile web add <pkg>     # 用干净 profile 从 npm 装一次
```

发布前确认：

- `private` 字段**不存在**（有 `private: true` 会被 npm 拒绝）；
- `files` 白名单包含 `lib`、`icon.svg`、`cordis.patch.yml`、`README.md`、`CHANGELOG.md`（以及你要带的 `docs/`）；
- `exports["./client"]` 指向真实存在的文件，且 `lib/client.js` 就是最终产物（本仓库无构建步骤）；
- `name`、`version` 没被占用；`description`、`keywords`（含 `dsh`、`dsh-plugin`、`deepseek-harness`）、
  `repository`（带 `directory`）、`homepage`、`bugs`、`license` 都齐。

## 5. 上架插件市场

市场（DSH 里「设置 → 插件」的插件市场）读的是 `package.json` 元数据。已上架插件的产物里
能反推出的约定，逐条自查：

- `dsh.bundle.patch` 指向 `cordis.patch.yml`；`cordis.patch.yml` 里
  **entry 的 `id` 必须与包名一致且全局唯一**（市场按它比对 entryIds）。
- **`id:` 那一行不能写行尾注释**：市场预检用正则抓该行值并要求其后直接换行，行尾注释会被判成缺 entry ID。
- `dsh.client = { platform: 'web', inject: [...] }`；`inject` 里只写确实需要的基线包，空数组合法。
- `dsh.compatibility.dshReleases` 至少给出一个 `compatible` 的版本，且是**自己实测过**的。
- `icon` 指向包内相对路径的 `svg/png/jpg/jpeg/webp`，≤ 256 KiB，realpath 后仍在包目录内。
- `keywords` 至少带 `dsh`、`dsh-plugin`、`deepseek-harness`。
- README 有安装命令、截图、数据/隐私说明。

提交渠道以官方说明为准（市场页面的投稿入口或官方文档）；本仓库不写死链接。提交后：

1. 等审核；被拒时按返回的错误码改元数据（最常见是 entry ID 或兼容性列表）。
2. 上架后用**干净 profile** 装一次，确认市场安装路径可用：

   ```bash
   dsh plugin --profile web add <name>
   ```

## 6. 回滚

| 情况 | 做法 |
|---|---|
| 元数据/描述写错 | 直接发 patch 版本覆盖（npm 不允许重发同版本） |
| 功能严重回归 | `npm deprecate <pkg>@<bad> "回退到 <good>"`，市场侧公告，发修复版 |
| 数据格式写坏 | 立即发布带「读取旧数据 + 迁移」的 patch，不要求用户手动改 |
| 上架后被判定违规 | 从市场下架、`npm unpublish`（仅 72 小时内且无人依赖时可行），发新版本 |

## 7. 自动化（可选）

`.github/workflows/ci.yml` 每次 push / PR 跑两个 job：

- `check`（Node 22/24 矩阵）：`node scripts/check.mjs`；
- `pack`：`node scripts/pack-check.mjs`（真的 `npm pack` 一遍检查产物）。

插件的 `prepublishOnly` 已经接上了 `check.mjs` + `pack-check.mjs`，所以 `npm publish`
之前会自动过一遍，不会把漏文件/元数据错的包发出去。如果之后要自动发布，建议：

- 只在打 tag 时触发，且 `npm publish` 用 granular token（权限最小化）；
- 发布前强制跑 `scripts/check.mjs` 与 `scripts/pack-check.mjs`（现在由 `prepublishOnly` 保证）。

> 推送 `.github/workflows/` 需要 token 带 `workflow` scope：`gh auth refresh -s workflow`。
