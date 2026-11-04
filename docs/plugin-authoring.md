# DSH 客户端插件开发笔记

写给「想给 DSH Web 加一点界面」的人。内容来自本仓库 `dsh-sticky-notes` 的实现与踩坑，
涉及 DSH `0.2.1-rc.2`（桌面端 0.12.1）。DSH 迭代较快，遇到不一致时以实际行为为准。

## 1. 插件是一个包 + 一张挂载声明

```
plugins/dsh-my-plugin/
├── package.json        # name / version / dsh.bundle.patch / dsh.client / exports["./client"]
├── cordis.patch.yml    # - insert: [{ id, name }]，把包挂进 profile 的配置树
├── lib/index.js        # 宿主半侧（Node）：Cordis 插件，可空
└── lib/client.js       # 浏览器半侧：普通脚本，就是产物，无需构建
```

`package.json` 关键字段：

```jsonc
{
  "name": "dsh-my-plugin",                // 必须与目录名一致，也是 bundle 的解析名
  "main": "lib/index.js",
  "exports": {
    ".": { "default": "./lib/index.js" },
    "./client": "./lib/client.js"         // DSH 据此提供 /plugins 下的浏览器 bundle
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "inject": [] }
  }
}
```

`cordis.patch.yml` 只要一行：

```yaml
- insert:
    - id: dsh-my-plugin
      name: dsh-my-plugin
```

## 2. 浏览器半侧的契约

`lib/client.js` **不能有顶层 ESM import / export**（它会被当普通脚本执行）。固定形状：

```js
;(function () {
  window.__ModuleLoader__.load({
    id: 'dsh-my-plugin',
    factory: function (require) {
      const React = require('react')          // 平台种子模块，直接取
      const h = React.createElement

      const name = 'dsh-my-plugin'
      const inject = ['slots']                // 等服务就绪后再 apply

      function apply(ctx) {
        ctx.slots.inject('shell.overlay', function* () {
          yield ctx.slots.register(
            { name: 'shell.overlay', id: 'my-panel', order: 860 },
            function () { return h(MyPanel, { ctx: ctx }) },
          )
        })
      }

      return { name, inject, apply }
    },
  })
})()
```

要点：

- `factory(require)` 返回模块对象本身（不是 `{ default }`）。
- `inject` 写的是 **Cordis 服务名**（`slots`、`locale`、`commandUi`…），不是包名；
  不想让插件在服务缺失时加载失败，就别把可选服务写进去，改用 `ctx.get('x')` 惰性取。
- `require` 里可用的还有：`react/jsx-runtime`、`react-dom/client`、`@deepseek-ai/dsh-client-ui-primitives`。
  取不到的模块要 try/catch 降级，绝不能让插件加载失败。

## 3. 插槽（slot）怎么选

**先查再写**：用 Cordis 的客户端检查器列出活插槽与用途，不要凭猜测。

```
cordis_inspect_query(platform='client', provider='Slots', method='listSubTree', input={root:'shell.overlay'})
```

返回里 `catalog` 会告诉你这个 slot 的定位、注册参数、`replaceRisk`，以及当前 `occupants`。

常用「加东西」的槽：

| slot | 用途 | 典型用法 |
|---|---|---|
| `shell.overlay` | 覆盖所有列之上的浮动层（click-through，条目自己开 pointer-events） | 悬浮面板、徽标、toast |
| `sidebar.panellist` | 左列全局面板图标 | 增加一个中央面板入口 |
| `sidebar.footer.action` | 侧栏底部设置旁的动作 | 小按钮 |
| `settings.section` | 设置页整页 | 插件配置页 |
| `settings.general.item` | 设置页「通用」里的单行 | 单个开关 |
| `conversation.input.left` / `.right` | 输入框工具栏两侧 | 输入框旁的小控件 |

**别替换带 `replaceRisk: shadows-shipped-ui` 的槽**（如 `sidebar`、`main`），那是覆盖 DSH 自己的界面。

`shell.overlay` 是最安全的「加一个浮层」入口：不参与列布局、不影响滚动容器，
`ctx.slots.register({ name, id, order }, Component)` 里 `id` 用自己新的名字即可，
重用已存在的 id 会顶掉别人的条目。

## 4. 主题 token：别写死颜色

DSH 的 CSS 变量都以 `--dsw-` 开头，随主题（light / dark）切换。实测的真实值：

| token | light | dark |
|---|---|---|
| `--dsw-alias-bg-layer-1` | `#ffffff` | `#232324` |
| `--dsw-alias-bg-layer-2` | `#ffffff` | `#2c2c2e` |
| `--dsw-alias-label-primary` | `#0f1115` | `#f9fafb` |
| `--dsw-alias-label-secondary` | `#61666b` | `#cfd3d6` |
| `--dsw-alias-brand-primary` | `#0f1115`（近黑） | `#f9fafb`（近白） |
| `--dsw-alias-border-l1` | `rgba(0,0,0,.04)` | `rgba(255,255,255,.06)` |

**最大的坑**：`brand-primary` 是「反色语义」——浅色主题是近黑、深色主题是近白。
把按钮做成「品牌色底 + 白字」在深色主题下就是白底白字（实测 1.05:1，等于看不见）。
正确做法是文字用反色 `var(--dsw-alias-bg-layer-1)`：

```css
.btn { background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-layer-1); }
```

其它注意：

- 深色主题靠 `body[data-ds-dark-theme]` 属性切换，覆盖样式用 `body[data-ds-dark-theme] .your-scope { ... }`。
- `bg-layer-1` 和 `bg-layer-2` 在浅色主题下同为 `#fff`，靠背景色分层会看不出来 →
  用 8% 中性底纹或边框区分卡片。
- 次级文字用 `label-secondary`（浅色 5.80:1、深色 10.42:1，达 AA）。

## 5. DSH 自己的 DOM 钩子

一些稳定的 `data-*` 属性可以拿来做定位，比猜 class 名可靠：

| 选择器 | 含义 |
|---|---|
| `[data-dsh-sidebar-root]` | 左侧「会话列表」列容器；可量宽度，宽度可拖拽 |
| `[data-shell-overlay]` | `shell.overlay` 的容器 |
| `body[data-ds-dark-theme]` | 当前是深色主题 |

例：把浮动面板贴着会话列表右边缘展开。

```js
function measureLeft() {
  const column = document.querySelector('[data-dsh-sidebar-root]')
  if (!column) return 0
  const right = Math.round(column.getBoundingClientRect().right)
  // 量到离谱值时退回 0，别把面板推到屏幕外
  return right > window.innerWidth * 0.7 ? 0 : right
}
// 宽度会变：resize + ResizeObserver 都要跟
```

## 6. 持久化

- 客户端插件没有 Host 存储 API 时，`localStorage` 是最省事的落点，注意分 key：
  **内容一个 key、界面状态（开合/视图）一个 key**。混在一起会让两个标签页互相覆盖、来回回写。
- 多标签页同步用 `window.addEventListener('storage')`，并做「内容相同就不 setState」比较，
  否则两边会互相触发回写。
- 一定要 `try/catch`（隐私模式、配额满都会抛）。
- 想跨设备/多端就必须改用 Host 侧存储（要写宿主半侧 + 请求通道），不要在插件里偷偷上传。

## 7. 可达性与健壮性基线

本仓库的插件都按这一套做：

- 命中区 ≥ 24×24（WCAG 2.2 AA），图标按钮 28–32px。
- 正文对比度 ≥ 4.5:1；自己算过再提交（不要凭感觉）。
- 有反馈的地方给 `aria-live`（例如「已删除 · 撤销」）。
- 焦点管理：打开面板时聚焦输入框；`Esc` 分层退出（先清搜索再关面板）；点外面关闭。
- 组件外包一层 error boundary：渲染失败只让自己消失，不许拖垮 DSH 界面。
- 不劫持 `html/body` 的滚动、不 `position: fixed` 全屏遮罩，除非确实需要模态。

## 8. 安装、调试、热更新

```bash
# 本地开发：link 安装（把源码链进 profile）
dsh plugin --profile web add link:<绝对路径>/plugins/dsh-my-plugin

# 改完代码后必须重装：安装会把源码快照进 profile 的 generation 目录
dsh plugin --profile web remove dsh-my-plugin
dsh plugin --profile web add link:<同一个绝对路径>
```

- 重装后一般页面会自动跟上；没跟上就刷新一次。
- 确认插件真的活着：查客户端 slot 的 occupants，`registrant` 是你的包名且 `active: true`。
- 只在「从源码跑 `pnpm run dev:web`」时才有真正的客户端 HMR；否则都要重装 + 刷新。
- 插件报错先看浏览器控制台；插件内部所有 require 都该 try/catch，失败时降级而不是白屏。

## 9. 测试

本仓库用四件套，都不依赖 DSH 运行：

1. **语法检查**：`new vm.Script(source)` 只编译不执行（client.js 顶层读 `window`，直接跑会炸）。
2. **冒烟测试**（`test/smoke.mjs`）：假 `window` / `react` / `ctx`，跑真实的 `factory → apply → 组件渲染`，
   断言注册的 slot、关键元素、ARIA 状态。能抓到「加载即抛」「注册到错的槽」「渲染丢元素」。
3. **行为测试**（`test/behavior.mjs`）：自己实现一个迷你 React（`useState` 真存状态、
   `useMemo`/`useCallback` 按依赖缓存、`memo` 带 per-key 缓存、`useEffect` 按依赖执行、
   定时器用虚拟时钟 `advance(ms)`），直接驱动组件点按钮、打字、拖放、传文件。
   这是唯一能在没有浏览器的情况下测「交互后果」的一层。
4. **对比度测试**（`test/contrast.mjs`）：从 DSH 主题包的真实 CSS 里解析 `--dsw-*`
   声明（按 `body[data-ds-dark-theme]` 分浅/深两套），递归解析 `var()` 链，按 WCAG 公式算真实配色对。
   找不到主题包就 SKIP，所以 CI 上没装 DSH 也不会挂。
5. **静态预览**（`test/preview.mjs`）：把组件真实输出序列化成 HTML，套上 DSH 主题 token 的静态外壳，
   用无头浏览器截图核对浅色 / 深色 / 收起态。

```bash
node scripts/check.mjs                       # 全仓库：结构 + 语法 + 上面这些测试
node scripts/pack-check.mjs --list           # 真的 npm pack 一遍，检查产物
node plugins/dsh-my-plugin/test/preview.mjs  # 生成预览页
```

### 写行为测试的两个坑

- **hook 要有真语义**：假 React 里 `useMemo(factory)` 如果忽略依赖数组，每次都返回新对象，
  那么给组件加的 `memo` 永远不会命中——量出来的数据是假的。依赖缓存必须实现。
- **定时器要有时钟**：`setTimeout` 一调度就执行的话，「5 秒撤销窗口」「300ms 去抖落盘」这类
  行为根本测不到（刚设上就被执行掉了）。用虚拟时钟，测试里显式 `advance(300)`。

## 10. 发布相关的硬规则（都是撞出来的）

### 市场怎么把 entry 挂到你的包上

看 `dshmarket/lib/entry-identity.js` 的真实判定：

```js
name === packageName || name.startsWith(`${packageName}/`)
```

所以 **`cordis.patch.yml` 的 `name:` 必须等于包名（或包名下的子路径）**，
而 `id:` 只需要在 profile 里全局唯一，**不必等于包名**。包名带 scope 时：

```yaml
- insert:
    - id: my-plugin                 # 纯 token，不加引号、不写行尾注释
      name: "@you/my-plugin"        # @ 开头在 YAML 里必须加引号
```

### npm 包名可能已经被占用

`npm publish` 之前先 `npm view <name> version`。被占用时的报错长这样：

```
Cannot implicitly apply the "latest" tag because previously published version 1.0.3
is higher than the new version 0.1.9
```

这不是版本号问题，是**名字被别人占了**。解法是发到自己的 scope 下（`@you/dsh-xxx`），
再按上面的规则同步改 `name:`。

### 改包名时，`lib/client.js` 里的 loader id 必须一起改

浏览器半侧是这样注册的：

```js
window.__ModuleLoader__.load({ id: '<package.json 的 name>', factory })
```

Web 端按**包名**去模块表里取浏览器半侧。id 写错（最常见：改名后还留着旧短名）的后果是
**静默不加载**——面板整个不出现，控制台也没有任何报错，因为「没人来取」不算错误。

三处身份要一致，建议在文件顶部写一个常量：

```js
var PKG_NAME = '@you/dsh-my-plugin'   // = package.json 的 name
LOADER.load({ id: PKG_NAME, factory })
module.exports = { name: PKG_NAME, inject: ['slots'], apply }        // 正常分支
return { name: PKG_NAME, inject: [], apply: function () {} }         // React 缺失兜底
```

而 `cordis.patch.yml` 的 `id:` 是**另一回事**（profile 内唯一键，可以继续用短名），
不要把它和模块 id 混在一起。

冒烟测试里的身份断言**从 `package.json` 读**，不要写死字符串——本仓库就是写死了旧短名，
导致「改名后静默不加载」这个回归没被测出来。

### 打包产物和源码树是两回事

`files` 白名单对不对、`test/` 有没有混进去、icon 有没有超 256KiB、包内产物是不是最新的，
只有真跑 `npm pack` 才看得见。把它做成脚本 + CI job + `prepublishOnly`，就不用每次发布手工检查。

## 11. 常见坑

| 现象 | 原因 | 处理 |
|---|---|---|
| 插件装了但页面没反应 | 没重装（generation 是快照）或页面没刷新 | remove + add，再刷新 |
| Host 侧 entry 是 active，页面里却查不到 slot occupant | Host 重启后 `/plugins/events`（HMR 图事件流）断开，页面不再收到图更新，只有刷新才重新拉图 | 刷新页面；这不是插件代码问题 |
| 把可选服务写进 `inject` 后插件完全不加载 | `inject` 里的服务未就绪时 `apply` 不会执行（Cordis 在等依赖） | 硬依赖只留 `slots`；`locale` 等可选服务用 `ctx.get(...)` 惰性探测 |
| `locale.register` 抛错导致 slot 从未注册 | 不同版本对字典完整性/重载要求不同 | 注册包 try/catch，失败退回内置文案；`bind` 也包一层兜底 |
| 加载即报错、整个页面白屏 | client.js 顶层用了 `import`/`export` 或访问了不存在的全局 | 用 `window.__ModuleLoader__.load`，所有 require 加 try/catch |
| 深色主题下按钮看不见 | 品牌色底 + 白字 | 文字改用 `var(--dsw-alias-bg-layer-1)` |
| 面板盖住会话列表 | 用 `left: 0` 定位 | 量 `[data-dsh-sidebar-root]` 的右边界 |
| 两个标签页来回覆盖数据 | 内容与界面状态存在同一个 key，且互相回写 | 拆 key + storage 事件做相等比较 |
| 拖动侧栏后面板位置没跟上 | 只监听了 window resize | 加 `ResizeObserver` 观察左列 |
| 冒烟测试「渲染不出面板」 | 组件只有在 open 时才构造面板 | 测试里预置开合状态 |
| 加了 `memo` 但没变快 | 传下去的 `t` / 对象 / 回调每次渲染都是新引用，浅比较必然失败 | 用 `useMemo`/`useCallback` 稳住 props；回调里别闭包可变状态，改读 ref |
| 打字时列表跳位 | 排序键（如 `updatedAt`）在输入时被刷新 | 打字期间不动排序键，失焦/提交时再更新 |
| 存储写失败但界面显示「已保存」 | 写入函数吞了异常，调用方无条件当成成功 | 写入返回成败，失败要如实提示 |
| 小字用语义色当文字色，对比度贴线 | 语义色是按「背景/图标」设计的，不一定满足 4.5:1 | 文字用 label 色、语义色只做边框/圆点，用对比度测试卡住 |
| 想读「当前会话」读不到 | slot 组件只取了 `locale`，把标准 kit props 丢了 | 注册函数把收到的 props 原样转发（`useSessions` 在里面） |
| 改了包名后便签栏整块消失、控制台无报错 | `lib/client.js` 的 `__ModuleLoader__.load({ id })` 还是旧包名，Web 端按包名取不到模块 | loader id / 模块 name / 兜底 name 统一用 `PKG_NAME` 常量；冒烟断言从 `package.json` 读包名 |
| 拖动排序把其他交互弄丢 | 逐字段重建 note 对象时漏了新字段（`order` / `sessionId`） | 重建地方全部带上；`normalizeNote` 给老数据兜底 |

