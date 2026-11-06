// 冒烟测试：用假的 window / react / ctx 跑一遍 lib/client.js 的加载与注册路径。
// 目的只是确认「脚本能解析、factory 能产出插件模块、apply 不抛、slot 注册到 shell.overlay」。
import fs from 'node:fs'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
// 身份类断言一律从 package.json 取，不写死字符串：
// 0.1.10 把包名改成带 scope 的形式时，client.js 的 loader id 忘了跟着改，
// 而这里断言的是旧的短名，于是「改名后浏览器半侧静默不加载」这个回归没被测出来。
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const elements = []
const buttons = []

function makeElement(tag) {
  const el = {
    tagName: tag,
    style: {},
    children: [],
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = value
    },
    appendChild(child) {
      this.children.push(child)
      return child
    },
    remove() {},
    querySelector() {
      return null
    },
    click() {},
  }
  return el
}

const localStorageData = new Map()
const fakeLocalStorage = {
  getItem: (key) => (localStorageData.has(key) ? localStorageData.get(key) : null),
  setItem: (key, value) => localStorageData.set(key, String(value)),
}

// 预置 7 条便签（其中一条置顶）并让面板展开：这样 render 会走到面板、搜索框、
// 便签卡片、置顶标记，能覆盖 P1 新增的路径。内容和开合分两个 key 存。
const now = Date.now()
const sampleNotes = [
  { id: 'note-pinned', text: '置顶的那条', color: 'amber', pinned: true, createdAt: now - 5000, updatedAt: now - 5000 },
  { id: 'note-1', text: '第一条便签', color: 'sky', pinned: false, createdAt: now - 4000, updatedAt: now - 4000 },
  { id: 'note-2', text: '第二条便签', color: 'mint', pinned: false, createdAt: now - 3000, updatedAt: now - 3000 },
  { id: 'note-3', text: '第三条便签', color: 'rose', pinned: false, createdAt: now - 2000, updatedAt: now - 2000 },
  { id: 'note-4', text: '第四条便签', color: 'violet', pinned: false, createdAt: now - 1000, updatedAt: now - 1000 },
  { id: 'note-5', text: '第五条便签', color: 'amber', pinned: false, createdAt: now, updatedAt: now },
  { id: 'note-6', text: '第六条便签', color: 'sky', pinned: false, createdAt: now + 1, updatedAt: now + 1 },
  { id: 'note-archived', text: '已归档的一条', color: 'mint', pinned: false, archived: true, archivedAt: now + 2, createdAt: now + 2, updatedAt: now + 2 },
]
localStorageData.set('dsh-sticky-notes:v1', JSON.stringify({ notes: sampleNotes }))
localStorageData.set('dsh-sticky-notes:open', '1')

let registered = null
const fakeCtx = {
  effect(callback) {
    const dispose = callback()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  slots: {
    inject(key, generator) {
      const iterator = generator()
      iterator.next()
      return () => {}
    },
    register(descriptor, component) {
      registered = { descriptor, component }
      return { dispose() {} }
    },
  },
  locale: {
    register() {},
    // 故意返回 undefined：让组件走「bind 拿不到就退回内置中文」的兜底路径。
    bind() {
      return () => undefined
    },
    subscribe() {
      return () => {}
    },
  },
}

// 极简 React 替身：足以让组件函数跑完一次 render，不关心输出。
// createElement 遇到函数组件 / 类组件会继续渲染下去，这样 render 期里的错误能暴露出来。
const fakeReact = {
  createElement(type, rawProps, ...children) {
    // 和真 React 一样：null props 变成对象，children 收到 props.children 上。
    const props = Object.assign({}, rawProps || {})
    if (children.length === 1) props.children = children[0]
    else if (children.length > 1) props.children = children
    const element = { type, props, children }
    elements.push(element)
    if (type === 'button') buttons.push({ props })
    if (typeof type === 'function') {
      if (type.prototype && typeof type.prototype.render === 'function') {
        const instance = new type(props)
        return instance.render()
      }
      return type(props)
    }
    return element
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

const fakeRequire = (id) => {
  if (id === 'react') return fakeReact
  throw new Error('unexpected require: ' + id)
}

let loaderConfig = null
const SIDEBAR_RIGHT = 248
const sandbox = {
  console,
  window: {
    __ModuleLoader__: {
      load(config) {
        loaderConfig = config
      },
    },
    localStorage: fakeLocalStorage,
    innerWidth: 1400,
    // 模拟一个 248px 宽的会话列表列，用来验证便签栏会贴着它的右边界展开。
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: (fn) => {
      return 0
    },
    clearTimeout: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  },
  document: {
    head: makeElement('head'),
    body: makeElement('body'),
    createElement: makeElement,
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: (selector) =>
      selector === '[data-dsh-sidebar-root]' ? { getBoundingClientRect: () => ({ right: SIDEBAR_RIGHT }) } : null,
  },
  Blob: class Blob {},
  URL: { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} },
}

vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

const problems = []
if (!loaderConfig) problems.push('脚本没有调用 __ModuleLoader__.load')
else {
  if (loaderConfig.id !== pkg.name) problems.push(`loader id 必须等于包名（${pkg.name}），实际：${loaderConfig.id}`)
  const mod = loaderConfig.factory(fakeRequire)
  if (!mod || typeof mod.apply !== 'function') problems.push('factory 没有返回带 apply 的模块')
  if (mod.name !== pkg.name) problems.push(`模块 name 必须等于包名（${pkg.name}），实际：${mod.name}`)
  if (!Array.isArray(mod.inject) || mod.inject.indexOf('slots') === -1) problems.push('inject 里没有 slots')
  mod.apply(fakeCtx)
  // 编辑态的一部分是纯样式（聚焦高亮 / 长文本编辑滚动），确认它们真的挂进了 <style>。
  const styleEl = sandbox.document.head.children.find(
    (el) => el.attributes && el.attributes['data-dsh-sticky-notes'] !== undefined,
  )
  if (!styleEl) problems.push('没有把样式挂到 document.head')
  else {
    const css = String(styleEl.textContent || '')
    if (css.indexOf('.dsn-edit-hint') === -1) problems.push('缺少「编辑中 · Esc 取消」提示样式')
    if (css.indexOf('.dsn-note:focus-within{border-color') === -1) problems.push('缺少编辑态卡片高亮样式')
    if (css.indexOf('.dsn-note-input:focus{outline:none;overflow-y:auto') === -1) problems.push('缺少长文本编辑滚动样式')
    if (css.indexOf('.dsn-voice{') === -1) problems.push('缺少语音录音状态行样式')
    if (css.indexOf('.dsn-voice-mic') === -1) problems.push('缺少草稿框语音按钮样式')
    if (css.indexOf('.dsn-search-voice') === -1) problems.push('缺少搜索框语音按钮样式')
    if (css.indexOf('.dsn-head-voice') === -1) problems.push('缺少头部语音搜索按钮样式')
    if (css.indexOf('.dsn-voice-level-fill') === -1) problems.push('缺少录音电平条样式')
    if (css.indexOf('.dsn-root[data-side="right"] .dsn-panel') === -1) problems.push('缺少右停靠面板镜像样式')
    if (css.indexOf('.dsn-root[data-mode="float"] .dsn-panel') === -1) problems.push('缺少自由摆放面板样式')
    if (css.indexOf('@keyframes dsn-slide-right') === -1) problems.push('缺少右停靠滑入动画')
    if (css.indexOf('.dsn-resize{') === -1) problems.push('缺少拖拽调宽度样式')
    if (css.indexOf('.dsn-layout-card{') === -1) problems.push('缺少布局卡样式')
  }
  if (!registered) problems.push('没有注册任何 slot 组件')
  else {
    if (registered.descriptor.name !== 'shell.overlay') problems.push('注册到的 slot 不是 shell.overlay')
    if (typeof registered.component !== 'function') problems.push('slot 注册的不是组件函数')
    // 跑一次组件函数：确认首屏 render 不抛（hooks 由替身满足）。
    registered.component()
    if (elements.length < 20) problems.push('render 出来的元素太少，面板可能没展开：' + elements.length)
    const hasPanel = elements.some((el) => el.props && el.props.className === 'dsn-panel')
    const hasNote = elements.some((el) => el.props && String(el.props.className || '').indexOf('dsn-note ') === 0)
    if (!hasPanel) problems.push('没渲染出便签面板')
    if (!hasNote) problems.push('没渲染出便签卡片')

    // 不能再有全屏遮罩：面板打开时不许压住会话列表。
    const hasCatcher = elements.some((el) => el.props && el.props.className === 'dsn-catcher')
    if (hasCatcher) problems.push('仍然渲染了全屏遮罩')

    // P1：便签够多时要有搜索框，每张卡片要有置顶按钮。
    const hasSearch = elements.some((el) => el.props && el.props.className === 'dsn-search')
    if (!hasSearch) problems.push('便签 ≥ 阈值时没有渲染搜索框')
    const pinButtons = elements.filter((el) => el.props && String(el.props.className || '').indexOf('dsn-pin-btn') !== -1)
    if (pinButtons.length !== sampleNotes.length - 1) problems.push('置顶按钮数量不对（归档的不该有）：' + pinButtons.length)
    const firstPin = pinButtons[0]
    if (firstPin && firstPin.props['aria-pressed'] !== 'true') problems.push('置顶便签的按钮没有 aria-pressed=true')

    // P2：归档视图 + 过滤器；初始视图是「全部」，不该渲染归档卡片，但过滤器要渲染。
    const filterButtons = elements.filter((el) => el.props && String(el.props.className || '').indexOf('dsn-filter-btn') !== -1)
    if (filterButtons.length !== 2) problems.push('过滤器按钮数量不对：' + filterButtons.length)
    const archivedInList = elements.some((el) => el.props && String(el.props.className || '').indexOf('is-archived') !== -1)
    if (archivedInList) problems.push('「全部」视图里出现了归档卡片')
    const archiveButtons = elements.filter((el) => el.props && String(el.props.className || '').indexOf('dsn-archive') !== -1)
    if (archiveButtons.length !== sampleNotes.length - 1) problems.push('归档按钮数量不对：' + archiveButtons.length)

    // 置顶的那条要排在列表最前面。
    const firstCard = elements.find((el) => el.props && String(el.props.className || '').indexOf('dsn-note ') === 0)
    const firstCardText = firstCard && Array.isArray(firstCard.props.children)
      ? firstCard.props.children.find((child) => child && child.props && child.props.className === 'dsn-note-input')
      : null
    if (!firstCardText || firstCardText.props.value !== '置顶的那条') {
      problems.push('置顶便签没有排到第一位：' + (firstCardText && firstCardText.props.value))
    }

    // 左列宽度应该被量到，并写到根节点的 --dsn-left 上；布局偏好三件套也要有。
    const root = elements.find((el) => el.props && String(el.props.className || '').indexOf('dsn-root') === 0)
    if (!root) problems.push('没找到根节点')
    else {
      if (!root.props.style || root.props.style['--dsn-left'] !== SIDEBAR_RIGHT + 'px') {
        problems.push('根节点没有把左列宽度写进 --dsn-left：' + JSON.stringify(root.props.style))
      }
      if (!root.props.style || root.props.style['--dsn-right'] !== '0px') {
        problems.push('根节点没有把右边距写进 --dsn-right：' + JSON.stringify(root.props.style))
      }
      if (!root.props.style || root.props.style['--dsn-width'] !== '300px') {
        problems.push('根节点没有默认宽度 --dsn-width：' + JSON.stringify(root.props.style))
      }
      if (root.props['data-side'] !== 'left' || root.props['data-mode'] !== 'dock') {
        problems.push('默认布局不是左停靠：' + root.props['data-side'] + '/' + root.props['data-mode'])
      }
    }

    // 收起状态：只剩左边缘的竖排标签，不该再渲染面板。
    elements.length = 0
    localStorageData.set('dsh-sticky-notes:open', '0')
    registered.component()
    const closedPanel = elements.some((el) => el.props && el.props.className === 'dsn-panel')
    const closedTab = elements.some((el) => el.props && String(el.props.className || '').indexOf('dsn-tab') === 0)
    if (closedPanel) problems.push('收起状态下仍然渲染了面板')
    if (!closedTab) problems.push('收起状态下没有渲染左边缘的便签标签')
  }
}

if (problems.length) {
  console.error('FAIL')
  for (const problem of problems) console.error(' - ' + problem)
  process.exit(1)
}
console.log('PASS  注册到 shell.overlay：' + JSON.stringify(registered.descriptor))
console.log('     render 产出元素数：' + elements.length)
