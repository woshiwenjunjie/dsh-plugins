# 市面便签 / 速记产品调研

> 目的：给 `dsh-sticky-notes` 找可迁移的模式，而不是堆功能。
> 结论先行：**值得学的是「捕获摩擦」「回顾重现」「上下文」三件事，不值得学的是通用笔记的容器化（文件夹/富文本/AI/同步）。**
> 调研时间：2026-11。范围 13 个产品，分三类：系统级便签、输入优先的笔记流、浏览器侧栏 / IDE 便签（与我们形态最接近）。

## 一、产品与它们的核心取舍

| 产品 | 形态 | 它为了什么牺牲了什么 | 关键特征 |
| --- | --- | --- | --- |
| Windows Sticky Notes（2024 改版） | 桌面便签 | 单页便签 → 列表 | 打开就是**便签列表**而非最后一张；搜索；**自动记录内容来源**（从哪个应用/网页抄来的，可跳回）；图片更好插入；OneNote 打通；置顶 |
| Google Keep | 卡片流 | 结构化笔记 → 快抓 | 颜色、**标签 label**、置顶、**时间/地点提醒**、归档、清单（可缩进子项）、语音/照片、**Quick Capture 贴边小组件** |
| Apple Notes · 快速笔记 | 系统级 | 无 | 全局热键 **Fn-Q** / 热角唤起；**上下文捕获**：自动附回当前网页或应用的链接 |
| SideNotes（macOS） | 屏幕边缘滑出 | 独立窗口 | 边缘滑出呼出；文件夹；颜色/置顶/**折叠**；搜索；隐藏 Markdown + 快捷格式栏；**清单（可一键清除已完成）**；图片/截图/链接 |
| Antinote（macOS） | 浮动小窗 | 无 Dock 图标 | **⌥A 唤起、再按一次消失**；滑动切换便签 |
| Tot | 菜单栏 | 只允许 **7 条** | 一排圆点：灰=空、彩色=有内容；纯文本；强迫整理 |
| flomo | 卡片流 | **没有文件夹** | 只有 `#标签`（支持多级）；**每日回顾**（App 内随机回顾，可限定标签/时间范围/条数；小组件；微信推送）；**随机漫步**（从一条游走到另一条）；相关笔记 |
| memos（usememos） | 自托管时间线 | **没有文件夹** | Timeline-first「打开就写」；Markdown 落盘可迁走；标签过滤、多列瀑布流、紧凑模式、链接预览 |
| Napkin Notes | Chrome **侧栏** | 最多 **10 条** | `Alt+X` 开侧栏；极简；标题/格式；跨便签搜索；**把便签关联到当前网站** |
| Sidebar Sticky Note（Opera） | 浏览器侧栏 | 无 | 侧栏、localStorage 存储、**看板式拖拽排序** |
| VS Code Notelets | IDE | 便签不是独立实体 | 每个文件一条 Markdown 便签，存 `.vscode/notelets/` 并**镜像目录结构**；**状态栏指示**该文件有没有便签 |
| Linger（VS Code/Cursor） | IDE | 便签可阻断流程 | 行级 / 文件级便签；**required 便签可阻塞 commit、push** |
| 小黄条（国内） | 桌面贴片 | 无 | 待办 + 便签 + 月历 + 日程贴桌面；**提醒**；多端 |

## 二、七个可迁移的模式

### 1. 默认视图是「列表」，不是「最后一张便签」

Windows Sticky Notes 老版本最被诟病的就是打开只有一张纸，找旧内容要翻；2024 改版把**列表**变成首屏（[评测](https://www.makeuseof.com/windows-11-new-sticky-notes-app-best-features/)、[Lifehacker 日本](https://www.lifehacker.jp/article/2503-windows-sticky-notes/)）。
映射：我们的抽屉本身是列表，天然对齐；要继续守住「打开面板第一眼看到的是全部便签」，任何新功能（回顾条、筛选）都不能把列表挤到需要滚动才可见。

### 2. 捕获必须自带上下文（source）

两个最强的系统级实现都在做同一件事：Apple [快速笔记](https://support.apple.com/ml-in/guide/macbook-pro/apdf79aa72fa/2022/mac/12.4) 自动附回网页/应用链接，Windows Sticky Notes 自动记录抄写来源（[来源](https://www.makeuseof.com/windows-11-new-sticky-notes-app-best-features/)）。IDE 侧走得更远：Notelets 把便签**绑到文件**并在[状态栏提示](https://github.com/nicksp/vscode-notelets/)，Linger 甚至能[按行绑定并阻塞提交](https://github.com/SamranTariq/Linger)。
映射：**这是我们最大的未被利用的资产。** 我们已经给便签存了 `sessionId`，但只用来做过滤芯片（「本会话 N」），既没在卡片上显示来源，也不能跳回去。「会话绑定」就是 DSH 版的 source capture，而且比 Windows 的自动抓源更准。

### 3. 回顾 / 重现 > 归档

flomo 把「回顾」当核心能力而不是附属功能：App 内每日回顾可限标签与时间范围、随机漫步在旧记录间游走、还有小组件与微信推送（[官方说明](https://help.flomoapp.com/method/use-review.html)、[随机漫步](http://help.flomoapp.com/ai/memory)）；理由是「新知识未必是重要的知识」。
映射：便签真正的死法是**沉底**——写在第 2 屏之后就再也没被看见。侧栏插件有天然优势：每次打开面板都是一次「被看见」的机会，只要在顶部放一条旧便签即可，成本极低。

### 4. 用标签取代文件夹

flomo 明确「没有文件夹，只有标签，结构在写作中生长」（[用户实践](https://help.flomoapp.com/community/user-story/record-life.html)、[V2EX 讨论](https://global.v2ex.co/t/1181371)），memos 同样是 timeline + 标签、无文件夹（[features](https://pkg.go.dev/github.com/usememos/memos@v0.29.0)），Keep 用 label + 颜色（[整理实践](https://harneetpasricha.com/organize-google-keep-notes/)）。
映射：我们要**拒绝**引入文件夹树（那会把侧栏变成文件管理器），但可以学「轻量结构」：正文里打 `#tag`，搜索即过滤，不新增任何 UI 与数据模型。

### 5. 约束本身就是功能

Tot 只给 7 条便签、Napkin 只给 10 条，都用稀缺性逼你整理（[Tot 介绍](https://apps.apple.com/cn/mac/story/id1507996679)、[Napkin Notes](https://chromewebstore.google.com/detail/napkin-notes-%E2%80%A2-side-panel/dlhljjkacijknfelknklfcohibfdciki)）；SideNotes 用「折叠」降低视觉噪音（[App Store](https://apps.apple.com/tw/app/sidenotes-screen-edge-notes/id1441958036)）。
映射：不建议硬性上限（我们是工作便签，剪掉会真丢信息），但**默认收起的克制**方向是对的；可以用「归档 + 超过 N 条时提示清理」代替硬上限。

### 6. 一按即写（零级进入）

Antinote 用 `⌥A` 在任何应用上方唤起小窗、再按一次消失（[评测](https://www.mac4ever.com/mac/197031-l-app-mac-du-jour-antinote-pour-prendre-rapidement-une-note)）；Napkin 用 `Alt+X` 开侧栏；Quick Note 用 `Fn-Q`/热角。共同点：**唤起后光标已经在输入框里**。
映射：我们有 `Alt+Shift+N` 开面板、`Ctrl+Enter` 记下，但唤起后不聚焦输入框就等于让用户多点一次。这是本次调研里**性价比最高的一条**。

### 7. 便签的第二形态是清单

Keep 与 SideNotes 都把 checklist 做成一级能力（缩进子项 / 一键清除已完成）。便签类产品里「待办」和「想法」本来就是同一张纸的两面。
映射：用 `- [ ]` / `- [x]` 轻解析 + 点击勾选即可，不引入专门的任务模型。

### 8. 反直觉的一条：便签可以是流程闸门

Linger 的「required 便签不解决就挡住 commit/push」把便签从「备忘录」变成「流程里的硬约束」。
映射：DSH 场景对应物是「收工前还有几条便签没处理」——可以作为可选仪式（例如某条便签标记为「待办未完成」时，面板图标显示红点）。仅作灵感记录，暂不实现。

## 三、明确不学的（防功能漂移）

| 不学 | 代表 | 原因 |
| --- | --- | --- |
| 文件夹树 / PARA 多级结构 | Notion、Obsidian | 侧栏只有 300px，层级会把列表挤没；标签足够 |
| 富文本 / 绘图 / 语音 / 图片 | Keep、Notes、Sticky Notes | 目标是「随手写一句话」，富内容会拖慢捕获与渲染 |
| 时间 + 地点提醒、系统通知 | Keep、小黄条 | 桌面通知在编码场景是干扰；要的是「下次打开就看到」，不是弹窗 |
| 云同步 / 账号 | Keep、小黄条 | 与「数据只存本机」的隐私定位冲突；已有 JSON 备份 + Markdown 导出作为逃生通道 |
| AI 总结/联想 | 各类新产品 | 本地纯前端插件没有稳定的推理入口，且会把简单功能做成不确定的东西 |

## 四、我们（0.1.12）的差距表

现状能力：侧栏抽屉（跟随左列宽度）、`Alt+Shift+N` 唤出、`Ctrl+K` 搜索（跨视图含归档、命中高亮）、`Ctrl+Enter` 记下、钉住、颜色、归档、5 秒撤销、拖拽 + 键盘重排、会话视图（过滤芯片）、JSON 备份/恢复（合并 + 可撤销）、Markdown 导出、草稿持久化、复制、中英双语、错误边界、`memo` 性能优化。

| 能力 | 市面代表 | 我们的现状 | 判断 |
| --- | --- | --- | --- |
| 首屏即列表 | Windows Sticky Notes | ✅ 已有 | 守住 |
| 零级进入（唤起即聚焦光标） | Antinote / Napkin / Quick Note | ⚠️ 有开关快捷键，但不聚焦输入框 | **补** |
| 捕获带上下文 | Quick Note / Sticky Notes / Notelets | ⚠️ 存了 `sessionId` 却只做过滤，不显示、不跳回 | **补（差异化）** |
| 回顾 / 重现 | flomo 每日回顾 | ❌ 无 | **补（低成本高感知）** |
| 轻量结构（标签） | flomo / Keep / memos | ⚠️ 只有全文搜索 | 补（`#tag`，零 UI） |
| 清单 | Keep / SideNotes | ❌ 无 | 补（`- [ ]` 解析） |
| 折叠 | SideNotes | ✅ 已折叠态 | 守住 |
| 存在感提示 | Notelets 状态栏 | ⚠️ 面板收起后无「有草稿」提示 | 补（小角标） |
| 硬性数量上限 | Tot / Napkin | ❌ 不做 | 不学 |
| 提醒 / 通知 | Keep / 小黄条 | ❌ 不做 | 不学（改用回顾条） |
| 拖拽排序 | Sidebar Sticky Note | ✅ 已有 | 守住 |

## 五、建议的下一步（按性价比排序）

| 优先级 | 改动 | 为什么 | 成本 | 风险 |
| --- | --- | --- | --- | --- |
| P0 | `Alt+Shift+N` 唤起后自动聚焦输入框 | 对齐 Antinote / Napkin 的「一按即写」，少一次点击 | 极小 | 会劫持焦点，需在面板收起时释放 |
| P0 | 面板收起时显示「有草稿 / 有钉住」小角标 | 对应 Notelets 状态栏；解决「有东西忘了」 | 小 | 折叠态渲染需保持轻 |
| P0 | 卡片显示来源会话 + 点击跳回 | 把已有的 `sessionId` 变成 Windows/Quick Note 式的 source；**这是别家补不上的差异化** | 中 | 跳转需走宿主提供的会话切换能力，能力不存在时要降级为只显示 |
| P1 | 搜索支持 `#tag` 过滤（正文解析） | flomo 的「无文件夹结构」，零新增 UI 与数据模型 | 小 | 与现有搜索高亮叠加，需保证不破坏 `Ctrl+K` |
| P1 | 顶部「前几天的一条」回顾条（可关） | flomo 每日回顾的极简版；治「写完就沉底」 | 小 | 需虚拟时钟测试；不能挤占首屏列表 |
| P2 | `- [ ]` 清单点击勾选 | Keep / SideNotes 的第二形态 | 中 | 纯 textarea 内点击勾选需处理光标位置 |
| P2 | 「过几天再看」（snooze） | 替代提醒通知的温和方案，与回顾条配合 | 中 | 状态字段增加，备份/合并逻辑要同步 |
| — | 文件夹、富文本、AI、云同步、系统通知 | 见第三节 | — | 不做 |

## 六、定位判断

市面上的便签分两派：**容器派**（Keep / Obsidian / Notion，越做越大）和**随手派**（Tot / Antinote / flomo / Napkin，越做越小）。我们属于随手派，优势不是功能多，而是**便签天然知道它是在哪个会话里写的**——这是 Windows Sticky Notes 花了一整版去做的「自动记录来源」，我们开局就有。

所以路线应该是：**把已有的上下文用起来（P0×3）→ 加最轻的组织与回顾（P1）→ 其余一律拒绝**。不要做第二个 Keep。

## 参考

- [Windows 11 新版 Sticky Notes 评测（MakeUseOf）](https://www.makeuseof.com/windows-11-new-sticky-notes-app-best-features/)
- [Windows 付箋アプリ新版（Lifehacker 日本）](https://www.lifehacker.jp/article/2503-windows-sticky-notes/)
- [Google Keep Quick Capture 小组件改版（Android Police）](https://www.androidpolice.com/google-keep-new-widgets-april-2025/)
- [Google Keep 的 pin / 提醒 / 标签整理实践](https://harneetpasricha.com/organize-google-keep-notes/)
- [Apple 快速笔记快捷键与上下文捕获（官方支持）](https://support.apple.com/ml-in/guide/macbook-pro/apdf79aa72fa/2022/mac/12.4)
- [flomo 每日回顾方法论](https://help.flomoapp.com/method/use-review.html)
- [flomo 随机漫步](http://help.flomoapp.com/ai/memory)
- [flomo 无文件夹、标签生长（用户实践）](https://help.flomoapp.com/community/user-story/record-life.html)
- [memos 特性列表（timeline-first、无文件夹、Markdown）](https://pkg.go.dev/github.com/usememos/memos@v0.29.0)
- [SideNotes – Screen Edge Notes（App Store）](https://apps.apple.com/tw/app/sidenotes-screen-edge-notes/id1441958036)
- [Antinote 评测（Mac4Ever）](https://www.mac4ever.com/mac/197031-l-app-mac-du-jour-antinote-pour-prendre-rapidement-une-note)
- [Tot：只允许 7 条便签（App Store 编辑故事）](https://apps.apple.com/cn/mac/story/id1507996679)
- [Napkin Notes：侧栏便签，最多 10 条](https://chromewebstore.google.com/detail/napkin-notes-%E2%80%A2-side-panel/dlhljjkacijknfelknklfcohibfdciki)
- [Sidebar Sticky Note（Opera 侧栏，拖拽排序）](https://addons.opera.com/en/extensions/details/sidebar-sticky-note/)
- [VS Code Notelets：文件级便签 + 状态栏指示](https://github.com/nicksp/vscode-notelets/)
- [Linger：required 便签可阻塞 commit](https://github.com/SamranTariq/Linger)
- [小黄条：桌面待办便签 + 提醒](https://app.mi.com/details?id=com.xiaohuangtiao)
