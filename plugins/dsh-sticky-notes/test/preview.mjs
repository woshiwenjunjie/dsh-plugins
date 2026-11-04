// 把 lib/client.js 真跑一遍（假 React + 假 window），把注册进去的组件渲染成 HTML，
// 再套上 DSH 主题变量的静态外壳，生成可截图的预览页。
// 目的：用真实组件输出验证视觉与布局，而不是另写一份手抄 HTML。
import fs from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

// 生成到 test/out/（git 忽略），提交进仓库的是 docs/ 下的成品截图。
const outDir = new URL('./out/', import.meta.url)
fs.mkdirSync(outDir, { recursive: true })
const clientPath = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const source = fs.readFileSync(clientPath, 'utf8')

// ---------------------------------------------------------------- 假 React

let collected = null
const fakeReact = {
  createElement(type, rawProps, ...children) {
    const props = Object.assign({}, rawProps || {})
    if (children.length === 1) props.children = children[0]
    else if (children.length > 1) props.children = children
    if (typeof type === 'function') {
      if (type.prototype && typeof type.prototype.render === 'function') {
        return new type(props).render()
      }
      return type(props)
    }
    return { type, props }
  },
  Component: class Component {
    constructor(props) {
      this.props = props
    }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect() {},
  useRef() {
    return { current: null }
  },
  useMemo(factory) {
    return factory()
  },
  useCallback(fn) {
    return fn
  },
}

const now = Date.now()
const notes = [
  { id: 'pin', text: '发布前要确认的三件事：\n1. 撤销窗口是 5 秒\n2. 搜索阈值是 6 条\n3. 埋点只在本地', color: 'violet', pinned: true, createdAt: now - 3 * 60 * 1000, updatedAt: now - 3 * 60 * 1000 },
  { id: 'a', text: '想到一个点子：把便签栏做成可折叠的，随时能写一句。', color: 'amber', pinned: false, createdAt: now - 90 * 1000, updatedAt: now - 90 * 1000 },
  { id: 'b', text: '下午 3 点和设计对一下首页改版', color: 'sky', pinned: false, createdAt: now - 42 * 60 * 1000, updatedAt: now - 42 * 60 * 1000 },
  { id: 'c', text: '读《卡片笔记法》第三章\n— 想法要写下来才算存在', color: 'mint', pinned: false, createdAt: now - 26 * 60 * 60 * 1000, updatedAt: now - 26 * 60 * 60 * 1000 },
  { id: 'd', text: '把「再点一次确认」换成 5 秒撤销，少一次打断', color: 'rose', pinned: false, createdAt: now - 3 * 60 * 60 * 1000, updatedAt: now - 3 * 60 * 60 * 1000 },
  { id: 'e', text: '搜索框只在便签 ≥ 6 条时出现', color: 'violet', pinned: false, createdAt: now - 5 * 60 * 60 * 1000, updatedAt: now - 5 * 60 * 60 * 1000 },
  { id: 'f', text: '导出时附带本机使用统计，用一周后看数据', color: 'amber', pinned: false, createdAt: now - 9 * 60 * 60 * 1000, updatedAt: now - 9 * 60 * 60 * 1000 },
  { id: 'archived', text: '已归档：旧的一周复盘（点「已归档」查看）', color: 'mint', pinned: false, archived: true, archivedAt: now - 2 * 24 * 60 * 60 * 1000, createdAt: now - 2 * 24 * 60 * 60 * 1000, updatedAt: now - 2 * 24 * 60 * 60 * 1000 },
]

const storage = new Map([
  ['dsh-sticky-notes:v1', JSON.stringify({ notes })],
  ['dsh-sticky-notes:open', '1'],
])
const sandbox = {
  console,
  window: {
    __ModuleLoader__: {
      load(config) {
        collected = config
      },
    },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
    },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  },
  document: { head: { appendChild() {} }, body: { appendChild() {} }, createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, remove() {} }) },
  Blob: class Blob {},
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

let registered = null
const ctx = {
  effect: (cb) => {
    const dispose = cb()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  slots: {
    inject: (key) => {
      return () => {}
    },
    register: (descriptor, component) => {
      registered = { descriptor, component }
      return { dispose() {} }
    },
    // 覆盖 inject：真实现里 inject 的 generator 由插件自己启动，这里手动跑一遍。
  },
  locale: {
    register() {},
    // 预览固定用中文：直接返回 zh 里的原文，省得再引一份字典。
    bind() {
      const zh = {
        name: '便签', 'tab.title': '便签栏（Alt+Shift+N）', 'tab.open': '打开便签栏', 'sub.empty': '随手记', unit: '条',
        export: '导出为 Markdown', close: '收起便签栏', 'close.esc': '收起便签栏（Esc）',
        'composer.placeholder': '写下此刻的想法…（Ctrl+Enter 记下）', 'composer.aria': '新便签内容',
        saving: '保存中…', saved: '已自动保存到本机', save: '记下',
        'search.placeholder': '搜索便签…（Ctrl+K）', 'search.aria': '搜索便签', 'search.clear': '清除搜索',
        'empty.none': '还没有便签', 'empty.none.sub': '上面写下想法，按 Ctrl+Enter 记下。',
        'empty.search': '没有匹配的便签', 'empty.search.sub': '换个关键词，或清空搜索。',
        'empty.archived': '还没有归档的便签', 'empty.archived.sub': '归档后随时能在这里找回来。',
        'note.placeholder': '空的便签…', 'note.aria': '便签内容', 'note.pinned': '置顶', 'note.pin': '置顶这条便签', 'note.unpin': '取消置顶',
        'note.color': '换个颜色', 'note.delete': '删除这条便签（可撤销）', 'note.archive': '归档这条便签', 'note.restore': '恢复这条便签',
        'time.justNow': '刚刚', 'time.minutesAgo': '分钟前', 'time.hoursAgo': '小时前',
        'toast.deleted': '已删除 1 条便签', 'toast.undo': '撤销', 'filter.all': '全部', 'filter.archived': '已归档',
      }
      return (key) => (Object.prototype.hasOwnProperty.call(zh, key) ? zh[key] : key)
    },
    subscribe() {
      return () => {}
    },
  },
}
// 覆盖成能驱动 generator 的 inject。
ctx.slots.inject = (key, generator) => {
  const it = generator()
  it.next()
  return () => {}
}

const mod = collected.factory((id) => {
  if (id === 'react') return fakeReact
  throw new Error('unexpected require ' + id)
})
mod.apply(ctx)
const tree = registered.component()

// ---------------------------------------------------------------- 序列化

const VOID_TAGS = new Set(['img', 'input', 'br', 'hr', 'circle', 'rect', 'path', 'line', 'polyline', 'stop'])
const PROP_ATTRS = {
  className: 'class',
  spellCheck: 'spellcheck',
  rows: 'rows',
  disabled: 'disabled',
  title: 'title',
  placeholder: 'placeholder',
  role: 'role',
  type: 'type',
  value: null, // textarea/input 的值单独处理
}

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function serialize(node) {
  if (node == null || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return escapeHtml(node)
  if (Array.isArray(node)) return node.map(serialize).join('')
  const { type, props } = node
  const attrs = []
  for (const [key, value] of Object.entries(props || {})) {
    if (key === 'children' || key === 'key' || key === 'ref') continue
    if (value == null || typeof value === 'function' || value === false) continue
    if (key.startsWith('on')) continue
    if (key === 'style' && value && typeof value === 'object') {
      const cssText = Object.entries(value)
        .map(([prop, propValue]) => `${prop}:${propValue}`)
        .join(';')
      attrs.push(`style="${escapeHtml(cssText)}"`)
      continue
    }
    const attr = Object.prototype.hasOwnProperty.call(PROP_ATTRS, key) ? PROP_ATTRS[key] : key
    if (attr === null) continue
    if (attr === 'disabled' && value !== true) continue
    if (key === 'strokeWidth') attrs.push(`stroke-width="${value}"`)
    else if (key === 'strokeLinecap') attrs.push(`stroke-linecap="${value}"`)
    else if (key === 'strokeLinejoin') attrs.push(`stroke-linejoin="${value}"`)
    else if (key === 'viewBox') attrs.push(`viewBox="${value}"`)
    else if (key === 'aria-hidden' || key === 'aria-label' || key === 'aria-expanded' || key === 'focusable') attrs.push(`${key}="${escapeHtml(value)}"`)
    else attrs.push(`${attr}="${escapeHtml(value)}"`)
  }
  const open = `<${type}${attrs.length ? ' ' + attrs.join(' ') : ''}>`
  if (VOID_TAGS.has(type)) return open.slice(0, -1) + ' />'
  let inner = serialize(props.children)
  if (type === 'textarea' && props.value != null) inner = escapeHtml(props.value)
  return open + inner + `</${type}>`
}

const markup = serialize(tree)

// 收起状态：只留左边缘的竖排标签。
storage.set('dsh-sticky-notes:open', '0')
const closedMarkup = serialize(registered.component())

// 从 client.js 里取出真正用的 CSS（apply 里塞进 <style> 的那段），保证预览和线上一致。
const cssMatch = /var CSS = \[([\s\S]*?)\]\.join\('\\n'\)/.exec(source)
if (!cssMatch) throw new Error('没找到 CSS 定义')
const css = cssMatch[1]
  .split(/\n/)
  .map((line) => line.trim())
  .filter((line) => line.startsWith("'") || line.startsWith('"'))
  .map((line) => {
    const raw = line.replace(/^['"]/, '').replace(/['"],?$/, '')
    return raw.replace(/\\'/g, "'").replace(/\\\\/g, '\\')
  })
  .join('\n')

// ---------------------------------------------------------------- 外壳

function shell(mode) {
  const dark = mode === 'dark' || mode === 'closed-dark'
  // 用 DSH 官方调色板的真实取值（从 @deepseek-ai/dsh-client-ui-theme 的 client.js 里读出来的）：
  // light：layer-1/2 都是 #fff，label-secondary #61666b，brand #0f1115；
  // dark ：layer-1 #232324、layer-2 #2c2c2e、label-secondary #cfd3d6、brand #f9fafb。
  const lightVars =
    '--dsw-alias-bg-base:#ffffff;--dsw-alias-bg-layer-1:#ffffff;--dsw-alias-bg-layer-2:#ffffff;--dsw-alias-bg-overlay:#e9ecf2;--dsw-alias-border-l1:#0000000a;--dsw-alias-label-primary:#0f1115;--dsw-alias-label-secondary:#61666b;--dsw-alias-brand-primary:#0f1115;--dsw-specific-sidebar-fill:#f9fafb;'
  const darkVars =
    '--dsw-alias-bg-base:#151517;--dsw-alias-bg-layer-1:#232324;--dsw-alias-bg-layer-2:#2c2c2e;--dsw-alias-bg-overlay:#2c2c2e;--dsw-alias-border-l1:#ffffff0f;--dsw-alias-label-primary:#f9fafb;--dsw-alias-label-secondary:#cfd3d6;--dsw-alias-brand-primary:#f9fafb;--dsw-specific-sidebar-fill:#1b1b1c;'

  const rows = ['新会话：给首页加个便签栏', '重构客户端模块加载器', '排查登录态失效', '周报草稿', '研究 PDF 预览插件']
    .map(
      (title, index) =>
        `<div class="mock-row${index === 0 ? ' is-active' : ''}"><span class="mock-dot"></span><span class="mock-row-title">${title}</span></div>`,
    )
    .join('')

  const chat = [
    ['你', '帮我在页面左边加一个便签栏，随时记录想法。'],
    ['DSH', '好的，我把便签栏改到会话列表右侧展开，不压住列表；命中区和对比度也一起修了。'],
  ]
    .map(
      ([who, text]) =>
        `<div class="mock-msg ${who === '你' ? 'is-user' : ''}"><div class="mock-who">${who}</div><div class="mock-bubble">${text}</div></div>`,
    )
    .join('')

  return `<!doctype html>
<html lang="zh-CN" data-mode="${mode}">
<head>
<meta charset="utf-8" />
<title>便签栏预览 · ${mode}</title>
<style>
  :root { ${lightVars} }
  body[data-ds-dark-theme] { ${darkVars} }
  html,body{margin:0;height:100%}
  body{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:"Segoe UI","Microsoft YaHei",system-ui,-apple-system,sans-serif;font-size:14px;overflow:hidden}
  .mock-app{display:flex;height:100vh}
  .mock-sidebar{width:248px;flex:0 0 248px;background:var(--dsw-specific-sidebar-fill);border-right:1px solid var(--dsw-alias-border-l1);padding:14px 10px;display:flex;flex-direction:column;gap:6px}
  .mock-brand{font-weight:650;font-size:13px;padding:6px 8px 12px;color:var(--dsw-alias-label-secondary)}
  .mock-row{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:8px;color:var(--dsw-alias-label-secondary);font-size:12.5px}
  .mock-row.is-active{background:rgba(127,127,127,.14);color:var(--dsw-alias-label-primary)}
  .mock-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-brand-primary);flex:0 0 auto}
  .mock-row-title{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
  .mock-main{flex:1 1 auto;display:flex;flex-direction:column;padding:26px 40px;gap:18px;min-width:0}
  .mock-msg{max-width:620px}
  .mock-msg.is-user{align-self:flex-end}
  .mock-who{font-size:11px;color:var(--dsw-alias-label-secondary);margin-bottom:5px}
  .mock-bubble{padding:11px 14px;border-radius:12px;background:rgba(127,127,127,.12);line-height:1.6;font-size:13.5px}
  .mock-msg.is-user .mock-bubble{background:rgba(127,127,127,.2)}
  ${css}
</style>
</head>
<body${dark ? ' data-ds-dark-theme=""' : ''}>
<div class="mock-app">
  <aside class="mock-sidebar" data-dsh-sidebar-root><div class="mock-brand">DeepSeek Harness</div>${rows}</aside>
  <main class="mock-main">${chat}</main>
</div>
${mode === 'closed' || mode === 'closed-dark' ? closedMarkup : markup}
<script>
  // 模拟插件里 measureSidebarLeft() 的效果：量左列右边界 → 写 --dsn-left。
  // 真机上这一步在 React effect 里跑，预览里没有真实 effect，只能在这里补。
  (function () {
    var column = document.querySelector('[data-dsh-sidebar-root]');
    var root = document.querySelector('.dsn-root');
    if (!column || !root) return;
    var right = Math.round(column.getBoundingClientRect().right);
    root.style.setProperty('--dsn-left', right + 'px');
    document.body.setAttribute('data-dsn-left', String(right));
  })();
  ${mode === 'toast' ? `
  // toast 只在「刚删完」的那一刻出现，静态序列化拍不到；这里按真实 DOM 结构补一个，
  // 只用来核对 .dsn-toast 的样式，不代表组件会这样渲染。
  (function () {
    var panel = document.querySelector('.dsn-panel');
    if (!panel) return;
    var list = panel.querySelector('.dsn-list');
    if (list) list.classList.add('has-toast');
    var toast = document.createElement('div');
    toast.className = 'dsn-toast';
    toast.setAttribute('role', 'status');
    var text = document.createElement('span');
    text.className = 'dsn-toast-text';
    text.textContent = '已删除 1 条便签';
    var undo = document.createElement('button');
    undo.type = 'button';
    undo.className = 'dsn-toast-undo';
    undo.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.5 5.5L4 9l3.5 3.5" /><path d="M4 9h9.5a5 5 0 0 1 0 10H9" /></svg><span>撤销</span>';
    toast.appendChild(text);
    toast.appendChild(undo);
    panel.appendChild(toast);
  })();` : ''}
</script>
</body>
</html>`
}

for (const mode of ['light', 'dark', 'closed', 'closed-dark', 'toast']) {
  const out = fileURLToPath(new URL(`./out/preview-${mode}.html`, import.meta.url))
  fs.writeFileSync(out, shell(mode))
  console.log('wrote ' + out)
}
console.log('markup length ' + markup.length + ', css length ' + css.length)
