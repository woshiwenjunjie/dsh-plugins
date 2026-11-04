# dsh-sticky-notes

DSH（DeepSeek Harness）Web 界面**左侧的便签栏**：随时把想法记在页面边上，不打断对话。

- 贴在会话列表右边缘，**不遮挡会话列表**，没有全屏遮罩。
- 就地编辑、置顶、换色、拖动排序、搜索（含归档、命中高亮）、按会话查看、备份恢复、5 秒撤销。
- 别的会话里写的便签带**来源标签**，点一下跳回那个会话。
- 数据只存**本机浏览器 localStorage**：不经 Host、不上报、不发网络请求。
- 快捷键 `Alt + Shift + N` 随时开关。

> npm 包名：`@woshiwenjunjie/dsh-sticky-notes`（`dsh-sticky-notes` 已被别的作者占用）。

![便签栏（浅色）](docs/light.png)

![便签栏（深色）](docs/dark.png)

删除后的撤销条：

![撤销](docs/undo.png)

收起时只剩贴边标签：

![收起](docs/collapsed.png)

## 安装

```bash
# 从 npm 安装（发布后）
dsh plugin --profile web add @woshiwenjunjie/dsh-sticky-notes

# 本地开发：直接链到本目录
dsh plugin --profile web add link:<本目录绝对路径>
```

也可以在 DSH 的「设置 → 插件」里安装。安装后刷新页面即可看到左边缘的「便签」标签。

## 能力一览

| 方面 | 有什么 |
|---|---|
| 捕获 | `Ctrl/Cmd + Enter` 记下；草稿实时落盘（刷新不丢）；新便签永远在最上面 |
| 组织 | 置顶、5 种颜色条、**拖动排序**（键盘 `↑`/`↓` 等价）、归档、`⋯`→「重排：按最近改动」 |
| 检索 | 搜索结果跨全部便签（含归档）、命中片段高亮、点一下那条就切回编辑；`Ctrl/Cmd + K` 聚焦 |
| 上下文 | 新便签记下所在**会话**，可切「本会话」视图（拿不到会话信息时该视图自动隐藏）；别的会话里写的便签带**来源标签**，点一下跳回那个会话 |
| 数据 | JSON 备份可**还原**（按 id 合并、可撤销）、Markdown 导出给人看、多标签页同步 |
| 安全网 | 删除 5 秒撤销；保存失败如实报错；非法备份只提示不动数据 |
| 可达性 | 命中区 ≥ 24px、对比度全部过 WCAG AA（有测试）、`Esc` 分层退出、收起后焦点归还 |
| 性能 | 卡片 memo 化：打字只重渲染 1 张；300 条稳态 0.30ms |

## 用法

| 操作 | 方式 |
|---|---|
| 展开 / 收起 | 点左边缘的「便签」标签；`Esc`；点面板外面 |
| 全局开关 | `Alt + Shift + N` |
| 记下一条 | 顶部输入框，`Ctrl/Cmd + Enter` 或点「记下」 |
| 编辑 | 直接点便签正文改；搜索态下点一下那条只切回这一条 |
| 排序 | 拖卡片左边缘的把手（hover 显现）；或聚焦把手按 `↑` / `↓`；`⋯`→「重排：按最近改动」复位 |
| 复制一条 | 鼠标移到便签上（或键盘聚焦卡片）→ 右下角出现复制按钮 |
| 换色 / 置顶 / 归档 / 删除 | 每条便签下方的一排按钮 |
| 撤销删除 | 删除后 5 秒内点底部「撤销」 |
| 搜索 | 便签 ≥ 6 条时出现搜索框，`Ctrl/Cmd + K` 聚焦，`Esc` 先清搜索 |
| 视图切换 | 「全部 / 本会话 / 已归档」 |
| 回到原会话 | 点便签底部的**来源标签**（只在「不是当前会话写的」时出现） |
| 备份 / 恢复 | 右上角 `⋯` →「导出备份（JSON）」/「从备份恢复…」 |
| 导出 | 右上角导出按钮 → Markdown（文末附本机使用统计） |

## 设计取舍

- **抽屉不遮挡**：面板贴在会话列表右边界展开（量 `[data-dsh-sidebar-root]` + `ResizeObserver` 跟随拖动/折叠），
  而不是盖住左侧一列，也没有全屏压暗——记便签不该让你看不见会话。
- **删除用「5 秒撤销」而不是「点两次确认」**：确认框会打断思路，撤销不会。
- **排序是「你排的」**：拖动之后顺序固定，编辑不再把便签顶到最上面（否则一编辑就打乱手动顺序）。
  新便签永远落最上面，`⋯` 里留了按时间重排的兜底。
- **搜索阈值 6 条**：少于 6 条时列表一眼看得完，搜索框只会占地方。
- **控件自研而非用 primitives 的 Button/Input**：300px 抽屉的密度不适合设置页尺度的控件。

## 记下就不会丢

- **草稿实时落盘**：还没按「记下」的内容存在 `dsh-sticky-notes:draft`，刷新页面、重装插件、
  手滑关页面回来还在；按「记下」后立即清掉。
- **保存失败如实说**：localStorage 写不进去（满了 / 被禁用）时提示变红「保存失败，请先导出」，
  恢复可写后自动回到「已保存」——不会给你一个假的「已保存」。
- **中文输入法安全**：组词选字时按回车不会被当成「记下」。
- **多标签页同步**：内容与开合状态分两个 key 存，两个标签页同时开着不会互相覆盖。

## 找得回

- **搜索跨视图**：有关键词就搜全部（含已归档），命中的归档便签带「已归档」标记、保持只读；
  此时过滤标签同步高亮「全部」，语义不打架。
- **命中高亮**：`<textarea>` 里画不出 `<mark>`，所以搜索态正文切成「只读 + 高亮」渲染；
  **点一下那条**就只把这一条切回 `textarea` 并自动聚焦，其余仍只读，搜索词不变。
- **本会话视图**：新便签记下它是在哪个会话里写的，切会话时该视图自动跟着变。
- **来源可点**：别的会话里写的便签，底部会显示那个会话的标题；`3 天前想到的这条路是谁提的` ——
  点一下直接跳回原会话看上下文。会话标题查不到（会话已删）时显示「其他会话」。

## 备份与恢复

数据只在你这台浏览器的 localStorage 里，所以**备份是唯一的安全网**：

| 动作 | 产物 | 用途 |
|---|---|---|
| 导出 | `sticky-notes-日期.md` | 给人读、贴到别处 |
| 导出备份 | `sticky-notes-日期.json` | **可还原**：id / 颜色 / 置顶 / 归档 / 会话 / 顺序 / 时间戳全保留 |
| 从备份恢复 | — | 按 `id` 合并：同 id 取 `updatedAt` 较新的，新 id 追加，提示「已导入 N 条 · 更新 M 条」 |

- 导入后 5 秒内可撤销（整份换回导入前）。
- 认不出文件或备份里没有便签时只提示，**一个字节都不动**现有数据。
- 老便签没有会话 / 顺序字段：读取时按 `-updatedAt` 兜底，等价于以前「最近改动在前」，不强制迁移。

## 键盘与可达性

| 项 | 值 / 做法 |
|---|---|
| 全局开关 | `Alt + Shift + N` |
| 记下 | `Ctrl/Cmd + Enter`（输入法组词中不触发） |
| 搜索 | `Ctrl/Cmd + K` 聚焦；`Esc` 先清搜索 |
| 退出层级 | `Esc`：先关菜单 → 再清搜索 → 最后收面板 |
| 焦点 | 收起后焦点回到左边缘的「便签」标签；点面板外面收起时不抢焦点 |
| 排序 | 把手聚焦后 `↑` / `↓` 移动一格 |
| 命中区 | 换色 24×24、删除 28×28、头部/卡片图标 32×32（WCAG 2.2 AA 底线 24px） |
| 对比度 | 全部走 DSH 主题 token，`npm run contrast` 用真实 token 值算 WCAG 比值（见下表） |

实测对比度（`npm run contrast` 的输出）：

| 用例 | 浅色 | 深色 |
|---|---|---|
| 正文 / 面板底 | 18.90 ✓ | 15.03 ✓ |
| 次要文字（时间、提示）/ 面板底 | 5.80 ✓ | 10.42 ✓ |
| 品牌底色上的文字（按钮、提示条） | 18.90 ✓ | 15.03 ✓ |
| 错误提示文字 / 面板底 | 18.90 ✓ | 15.03 ✓ |
| 错误色边框 / 保存失败圆点 | 4.50 ✓ | 4.77 ✓ |
| 搜索高亮片段文字 / 高亮底色 | 13.39 ✓ | 10.08 ✓ |

## 数据存在哪

全部存在**本机浏览器 localStorage**，不经 Host、不上传、不发网络请求：

| key | 内容 |
|---|---|
| `dsh-sticky-notes:v1` | 便签列表（含置顶 / 归档 / 会话 / 手动顺序字段，多标签页之间同步） |
| `dsh-sticky-notes:open` | 面板开合状态（只属于当前页） |
| `dsh-sticky-notes:draft` | 还没按「记下」的草稿（记下后立即清掉） |
| `dsh-sticky-notes:metrics:v1` | 本机埋点计数（导出 Markdown 时附在末尾） |

换浏览器或清站点数据会丢，重要内容请用 `⋯` →「导出备份（JSON）」留一份可还原的备份。
注意 localStorage 按 origin 隔离：`127.0.0.1:43129` 和 `localhost:43129` 是两个 origin，便签不互通。

## 实现要点

- 宿主半侧 `lib/index.js` 是空插件，只保证 `cordis.patch.yml` 里的 entry 能加载。
- 浏览器半侧 `lib/client.js` 是普通脚本：`window.__ModuleLoader__.load({ id, factory })`，
  由 `factory(require)` 返回 Cordis 插件模块 `{ name, inject, apply }`。
- `apply` 里用 `ctx.slots.inject('shell.overlay', ...)` 注册一个覆盖在所有列之上的浮动层，
  所以它不会改动 DSH 自己的布局和滚动容器；slot 送来的标准 kit props 会被原样转发给主组件
  （「当前会话」就是从里面的 `useSessions` 读的）。
- 卡片是 `memo(NoteCard)`：`t` / `timeLabels` / 回调都用 `useMemo` / `useCallback` 稳住引用，
  否则浅比较永远失败、memo 形同虚设。
- 拖动排序只记一个 ref、直接改 DOM class，**松手才提交一次顺序**，拖动过程零重渲染。
- 组件外包了一层错误边界：便签栏自身渲染失败时只隐藏它，不影响 DSH 界面。
- 更多 DSH 插件机制的细节见仓库的 [docs/plugin-authoring.md](../../docs/plugin-authoring.md)。

## 兼容性

只在 **DSH `0.2.1-rc.2`**（桌面端 0.12.1）实测通过。`package.json` 里的
`dsh.compatibility.dshReleases` 只声明实测过的版本；换版本请先跑 `npm test`。

## 开发

```bash
npm test         # smoke（加载与注册）+ behavior（迷你 React 驱动真实交互）
npm run contrast # 用真实主题 token 算 WCAG 对比度（缺主题包会 SKIP）
npm run perf     # 长列表重渲染成本：node test/perf.mjs <条数> <轮数> [客户端文件]
npm run preview  # 用真实组件输出生成静态预览页到 test/out/
```

四层测试都在 `node scripts/check.mjs` 里（CI 与本地同一套）：

| 测试 | 守什么 |
|---|---|
| `test/smoke.mjs` | 脚本能解析、能注册到 `shell.overlay`、首屏不抛 |
| `test/behavior.mjs` | 迷你 React（真 useState / 依赖缓存 / memo / 虚拟时钟）驱动真实交互：编辑不重排、输入法、落盘失败、搜索高亮、备份 round-trip、会话绑定、草稿、复制、拖动排序 |
| `test/contrast.mjs` | 从真实主题包解析 token，按 WCAG 算配色对比度 |
| `test/perf.mjs` | 整树渲染的元素数与耗时（可传客户端文件路径对比两个版本） |

零运行时依赖，不需要构建步骤：`lib/client.js` 就是发布产物。

## 变更记录

见 [CHANGELOG.md](CHANGELOG.md)。

## English summary

A sticky-notes side panel for the DSH (DeepSeek Harness) web UI. It docks at the right edge of the
session-list column (never covering it) and supports quick capture with a crash-proof draft, inline
editing, colors, pinning, drag-to-reorder (keyboard equivalent), search across all notes with match
highlighting, a per-session view, JSON backup/restore, a 5-second undo, and copy-to-clipboard.
Everything stays in the local browser — no Host, no network. i18n via `ctx.locale` (zh/en), icons from
DSH primitives, WCAG AA contrast verified by a test that reads the real theme tokens.
No build step, no runtime dependencies.

## License

MIT
