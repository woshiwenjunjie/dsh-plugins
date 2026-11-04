# dsh-sticky-notes

DSH（DeepSeek Harness）Web 界面**左侧的便签栏**：随时把想法记在页面边上，不打断对话。

- 贴在会话列表右边缘，**不遮挡会话列表**，没有全屏遮罩。
- 就地编辑、换色、置顶、搜索、归档、5 秒撤销；`Alt + Shift + N` 随时开关。
- 数据只存**本机浏览器 localStorage**：不经 Host、不上报、不发网络请求。

![便签栏（浅色）](docs/light.png)

![便签栏（深色）](docs/dark.png)

删除后的撤销条：

![撤销](docs/undo.png)

收起时只剩贴边标签：

![收起](docs/collapsed.png)

## 安装

```bash
# 从 npm 安装（发布后）
dsh plugin --profile web add dsh-sticky-notes

# 本地开发：直接链到本目录
dsh plugin --profile web add link:<本目录绝对路径>
```

也可以在 DSH 的「设置 → 插件」里安装。安装后刷新页面即可看到左边缘的「便签」标签。

## 用法

| 操作 | 方式 |
|---|---|
| 展开 / 收起 | 点左边缘的「便签」标签；`Esc`；点面板外面 |
| 全局开关 | `Alt + Shift + N` |
| 记下一条 | 顶部输入框，`Ctrl/Cmd + Enter` 或点「记下」 |
| 编辑 / 换色 / 置顶 / 归档 / 删除 | 每条便签下方的一排按钮 |
| 撤销删除 | 删除后 5 秒内点底部「撤销」 |
| 搜索 | 便签 ≥ 6 条时出现搜索框，`Ctrl/Cmd + K` 聚焦 |
| 归档视图 | 列表上方的「全部 / 已归档」 |
| 导出 | 右上角导出按钮 → Markdown（文末附本机使用统计） |

## 可用性基线（P0）

| 项目 | 之前 | 现在 |
|---|---|---|
| 换色按钮命中区 | 14×14 | 24×24（WCAG 2.2 AA 底线） |
| 删除按钮命中区 | 22×22 | 28×28 |
| 头部图标按钮 | 28×28 | 32×32 |
| 暗色主题品牌按钮 | 白字压近白底 1.05:1（几乎不可见） | 反色文字 15.03:1 |
| 浅色主题品牌按钮 | 18.90:1 | 18.90:1 |
| 提示文字 / 时间戳 | 浅色 5.80 / 深色 10.42 | 浅色 5.80 / 深色 10.42（卡片加 8% 底纹后时间戳 5.32，仍过 AA） |
| 面板是否遮挡会话列表 | 遮住整个 248px 左列 + 全屏压暗 | 遮挡 0px，无遮罩 |

颜色全部走 DSH 主题 token；压在品牌色上的文字用 `--dsw-alias-bg-layer-1`（反色），
因为品牌色在 light 主题下是近黑、dark 主题下是近白，写死 `#fff` 在暗色主题会变成白底白字。

## 可逆、可召回、可度量（P1）

| 改动 | 之前 | 现在 |
|---|---|---|
| 删除 | 点两次确认（打断思路、不可逆） | 立即删除 + 5 秒内「撤销」（`aria-live` 提示） |
| 召回 | 列表线性扫，没有搜索 | ≥ 6 条出搜索框，`Ctrl/Cmd + K` 聚焦，`Esc` 先清搜索 |
| 组织 | 只有时间序 | 图钉置顶（置顶排最前，带 `aria-pressed`） |
| 度量 | 没有数据，优化靠直觉 | 本机埋点 10 项，导出 Markdown 时附统计 |

## 系统化与一致性（P2）

| 改动 | 说明 |
|---|---|
| i18n | 接入 `ctx.locale`：zh 键集真源，en 对齐，其余语言按 en 回退；语言切换即时生效 |
| 归档 | 归档 / 恢复 + 过滤；归档卡片置灰、只读、主视图不占位 |
| 图标 | 换用 DSH primitives 的 Fluent 图标，取不到时回退手绘 SVG |
| 动效 | 面板与撤销条 120ms，`prefers-reduced-motion` 下关闭 |
| 控件取舍 | 保存按钮 / 输入框 / 撤销条保留自研紧凑控件（300px 抽屉的密度不适合设置页尺度的 primitives Button/Input） |

## 落地手感（0.1.2）

用起来才发现的三个问题，都改在最痛的地方：

| 问题 | 之前 | 现在 |
|---|---|---|
| 编辑时卡片跳位 | 每敲一个字就把这张便签顶到列表最前，滚动位置跟着跳 | 打字过程中不动排序，失焦后才更新「最近改动」；没真改过的点击不算 |
| 存储写失败 | localStorage 满了仍然显示「已自动保存」，刷新后内容没了 | 显示红色「保存失败，请先导出」（`role="alert"`），恢复可写后自动回到「已保存」 |
| 中文输入法 | 组词选字时按回车，半句话被当成一条便签存下、草稿被清空 | 判断 `isComposing`，组词期间回车只选词 |

这三条由 `test/behavior.mjs` 守着：用迷你 React 真跑组件状态与依赖，修复前跑会失败。

## 数据存在哪

全部存在**本机浏览器 localStorage**，不经 Host、不上传、不发网络请求：

| key | 内容 |
|---|---|
| `dsh-sticky-notes:v1` | 便签列表（含置顶 / 归档字段，多标签页之间同步） |
| `dsh-sticky-notes:open` | 面板开合状态（只属于当前页） |
| `dsh-sticky-notes:metrics:v1` | 本机埋点计数（导出 Markdown 时附在末尾） |

内容和开合状态分开存，是为了让两个标签页同时开着时不会互相覆盖、来回回写。
换浏览器或清站点数据会丢，重要内容请用「导出」备份。

## 实现要点

- 宿主半侧 `lib/index.js` 是空插件，只保证 `cordis.patch.yml` 里的 entry 能加载。
- 浏览器半侧 `lib/client.js` 是普通脚本：`window.__ModuleLoader__.load({ id, factory })`，
  由 `factory(require)` 返回 Cordis 插件模块 `{ name, inject, apply }`。
- `apply` 里用 `ctx.slots.inject('shell.overlay', ...)` 注册一个覆盖在所有列之上的浮动层，
  所以它不会改动 DSH 自己的布局和滚动容器。
- 左列边界从 `[data-dsh-sidebar-root]` 量（ui-sidebar 的列容器），并用 `ResizeObserver`
  跟随拖动 / 折叠更新；量不到就退回 0（贴最左边），不会比原来更糟。
- `inject: ['slots', 'locale']` 让插件等 slots 与 locale 服务就绪后再 apply。
- 组件外包了一层错误边界：便签栏自身渲染失败时只隐藏它，不影响 DSH 界面。
- 更多 DSH 插件机制的细节见仓库的 [docs/plugin-authoring.md](../../docs/plugin-authoring.md)。

## 兼容性

只在 **DSH `0.2.1-rc.2`**（桌面端 0.12.1）实测通过。`package.json` 里的
`dsh.compatibility.dshReleases` 只声明实测过的版本；换版本请先跑 `npm test`。

## 开发

```bash
npm test        # smoke（加载与注册）+ behavior（迷你 React 驱动真实交互）
npm run preview # 用真实组件输出生成静态预览页到 test/out/
```

零运行时依赖，不需要构建步骤：`lib/client.js` 就是发布产物。

## 变更记录

见 [CHANGELOG.md](CHANGELOG.md)。

## English summary

A sticky-notes side panel for the DSH (DeepSeek Harness) web UI. It docks at the right
edge of the session-list column (never covering it), supports quick capture, inline
editing, colors, pinning, search, archiving and a 5-second undo, and stores everything in
the local browser only. i18n via `ctx.locale` (zh/en), icons from DSH primitives.
No build step, no runtime dependencies.

## License

MIT
