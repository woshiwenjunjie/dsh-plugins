// 行为测试：不只确认「能渲染」，而是真的驱动交互，验证 0.1.2 修掉的三件事。
//
// 和 smoke.mjs 的区别：这里的 useState 会真的保存状态并触发重渲染（迷你 React），
// useEffect 会按依赖数组真正执行，所以能测「打字 → 排序 → 失焦 → 落盘失败」这类行为。
//
// 覆盖：
//   1. 编辑到一半时列表不重排（修复前：第一下按键卡片就跳到最顶）
//   2. 失焦后才更新「最近改动」，且没改过的点击不算
//   3. 中文输入法组词中按 Ctrl+Enter 不误存
//   4. localStorage 写失败时显示「保存失败」，不再谎报「已保存」
import fs from 'node:fs'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// ---------------------------------------------------------------- 造数据

const now = Date.now()
const seed = [
  { id: 'n-old', text: '旧的一条', color: 'amber', pinned: false, createdAt: now - 5000, updatedAt: now - 5000 },
  { id: 'n-mid', text: '中间那条', color: 'sky', pinned: false, createdAt: now - 3000, updatedAt: now - 3000 },
  { id: 'n-new', text: '最新那条', color: 'mint', pinned: false, createdAt: now - 1000, updatedAt: now - 1000 },
]
// 按 updatedAt 降序渲染：最新那条 → 中间那条 → 旧的一条
const EXPECTED_ORDER = ['最新那条', '中间那条', '旧的一条']

let storageFull = false
const storage = new Map([
  ['dsh-sticky-notes:v1', JSON.stringify({ notes: seed })],
  ['dsh-sticky-notes:open', '1'],
])

// ---------------------------------------------------------------- 迷你 React

let hookSlots = []
let refSlots = []
let effectSlots = []
let cursor = 0
let elements = []
let dirty = false
let pendingEffects = []
// 虚拟时钟 + 宏任务队列：定时器只在 advance(ms) 之后才到期，
// 这样「5 秒撤销窗口」和「300ms 去抖落盘」都能被测到，而不是一调度就被执行掉。
let clock = 0
let timers = new Map()
let timerSeq = 0
let focusedElement = null
let lastBlob = null
// 剪贴板：测试里捕获写进去的文本，也能模拟被拒绝。
let clipboardText = null
let clipboardFail = false
// 组件收到的 props：真环境里是 slot 的标准 kit（含 useSessions），测试里可以模拟。
let runtimeProps = {}
// 每个渲染 pass 真正渲染了几张卡片：用来验证 memo 生效（打字只该重渲染 1 张）。
let passCardRenders = 0
let maxPassCardRenders = 0
// 挂在 window 上的 keydown 监听也要能真触发：Alt+Shift+N / Esc / Ctrl+K 都走这条路。
const windowListeners = new Map()
function addWindowListener(type, fn) {
  const list = windowListeners.get(type) || []
  list.push(fn)
  windowListeners.set(type, list)
}
function removeWindowListener(type, fn) {
  const list = windowListeners.get(type)
  if (!list) return
  const index = list.indexOf(fn)
  if (index !== -1) list.splice(index, 1)
}

function createElement(type, rawProps, ...children) {
  const props = Object.assign({}, rawProps || {})
  if (children.length === 1) props.children = children[0]
  else if (children.length > 1) props.children = children
  if (typeof type === 'function') {
    if (type.prototype && typeof type.prototype.render === 'function') return new type(props).render()
    return type(props)
  }
  const element = {
    type,
    props,
    style: {},
    scrollHeight: 0,
    setAttribute() {},
    appendChild() {},
    remove() {},
    // 拖拽排序要用：元素在视口里的位置 + class 操作（组件里都是带存在性判断的）。
    getBoundingClientRect: () => ({ top: 0, height: 100, bottom: 100, left: 0, right: 200, width: 200 }),
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  }
  // 和 React 一样：ref 可以是对像也可以是函数；给个 focus 用来验证焦点去向。
  if (props.ref && typeof props.ref === 'object') {
    props.ref.current = element
    element.focus = () => {
      focusedElement = element
    }
  } else if (typeof props.ref === 'function') {
    element.focus = () => {
      focusedElement = element
    }
    props.ref(element)
  }
  elements.push(element)
  return element
}

const fakeReact = {
  createElement,
  Component: class Component {
    constructor(props) {
      this.props = props
    }
  },
  useState(initial) {
    const index = cursor++
    if (!(index in hookSlots)) hookSlots[index] = typeof initial === 'function' ? initial() : initial
    const setState = (value) => {
      const next = typeof value === 'function' ? value(hookSlots[index]) : value
      if (Object.is(next, hookSlots[index])) return
      hookSlots[index] = next
      dirty = true
    }
    return [hookSlots[index], setState]
  },
  useRef(initial) {
    const index = cursor++
    if (!(index in refSlots)) refSlots[index] = { current: initial === undefined ? null : initial }
    return refSlots[index]
  },
  useEffect(callback, deps) {
    const index = cursor++
    const previous = effectSlots[index]
    const changed =
      !previous ||
      !deps ||
      !previous.deps ||
      deps.length !== previous.deps.length ||
      deps.some((dep, i) => !Object.is(dep, previous.deps[i]))
    if (!changed) return
    pendingEffects.push({ index, callback, deps })
  },
  useMemo(factory, deps) {
    const index = cursor++
    const slot = hookSlots[index]
    if (slot && slot.__memo && deps && sameDeps(slot.deps, deps)) return slot.value
    const value = factory()
    hookSlots[index] = { __memo: true, deps: deps || null, value: value }
    return value
  },
  useCallback(fn, deps) {
    const index = cursor++
    const slot = hookSlots[index]
    if (slot && slot.__memo && deps && sameDeps(slot.deps, deps)) return slot.value
    hookSlots[index] = { __memo: true, deps: deps || null, value: fn }
    return fn
  },
  // memo 也要有真语义：命中缓存时把上次渲染出的子树重新「提交」一遍，
  // 这样断言看到的元素清单跟 React 里渲染结果一致，而 memo 带来的「陈旧 props」问题也能被测出来。
  memo(component) {
    const wrapper = (props) => {
      let byKey = memoCache.get(component)
      if (!byKey) {
        byKey = new Map()
        memoCache.set(component, byKey)
      }
      const id = props.key === undefined ? '' : String(props.key)
      const entry = byKey.get(id)
      if (entry && shallowEqual(entry.props, props)) {
        emitTree(entry.result)
        return entry.result
      }
      const result = component(props)
      byKey.set(id, { props: props, result: result })
      passCardRenders += 1
      return result
    }
    return wrapper
  },
}

let memoCache = new WeakMap()

function sameDeps(a, b) {
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (!Object.is(a[i], b[i])) return false
  return true
}

function shallowEqual(a, b) {
  if (a === b) return true
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  for (const key of keysA) if (!Object.is(a[key], b[key])) return false
  return true
}

// 把一棵已经构造好的元素树重新登记到 elements（模拟 React 复用上次的渲染结果）。
function emitTree(node) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) emitTree(item)
    return
  }
  if (typeof node.type === 'string') elements.push(node)
  if (node.props) emitTree(node.props.children)
}

const sandbox = {
  console,
  window: {
    __ModuleLoader__: {
      load(config) {
        sandbox.__loader = config
      },
    },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => {
        if (storageFull && key === 'dsh-sticky-notes:v1') throw new Error('QuotaExceededError')
        storage.set(key, String(value))
      },
      removeItem: (key) => {
        storage.delete(key)
      },
    },
    innerWidth: 1400,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: (fn, delay) => {
      timerSeq += 1
      timers.set(timerSeq, { fn, at: clock + (typeof delay === 'number' ? delay : 0) })
      return timerSeq
    },
    clearTimeout: (id) => {
      timers.delete(id)
    },
    addEventListener: addWindowListener,
    removeEventListener: removeWindowListener,
  },
  document: {
    head: { appendChild() {} },
    body: { appendChild() {} },
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, remove() {}, click() {} }),
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: (selector) =>
      selector === '[data-dsh-sidebar-root]' ? { getBoundingClientRect: () => ({ right: 248 }) } : null,
  },
  Blob: class Blob {
    constructor(parts, options) {
      this.parts = parts
      this.type = options && options.type
      lastBlob = this
    }
    text() {
      return Promise.resolve(this.parts.join(''))
    }
  },
  navigator: {
    clipboard: {
      writeText(text) {
        if (clipboardFail) return Promise.reject(new Error('denied'))
        clipboardText = String(text)
        return Promise.resolve()
      },
    },
  },
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
}

vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

// ---------------------------------------------------------------- 挂载组件

let registered = null
// 宿主服务：插件会用 ctx.get('uiWorkspace') 探测「跳回原会话」的能力，测试里由它决定给不给。
let fakeUiWorkspace = null
const ctx = {
  get(key) {
    return key === 'uiWorkspace' ? fakeUiWorkspace : null
  },
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
}
const mod = sandbox.__loader.factory((id) => {
  if (id === 'react') return fakeReact
  throw new Error('unexpected require: ' + id)
})
mod.apply(ctx)

function renderPass() {
  cursor = 0
  passCardRenders = 0
  elements = []
  pendingEffects = []
  registered.component(runtimeProps)
  if (passCardRenders > maxPassCardRenders) maxPassCardRenders = passCardRenders
  const effects = pendingEffects
  for (const effect of effects) {
    const previous = effectSlots[effect.index]
    if (previous && typeof previous.dispose === 'function') previous.dispose()
    const dispose = effect.callback()
    effectSlots[effect.index] = { deps: effect.deps, dispose: typeof dispose === 'function' ? dispose : undefined }
  }
}

function dueTimers() {
  const due = []
  for (const [id, timer] of timers) if (timer.at <= clock) due.push([id, timer])
  due.sort((a, b) => a[1].at - b[1].at)
  return due
}

function flush() {
  let guard = 0
  dirty = true
  while (dirty || dueTimers().length > 0) {
    if (guard++ > 60) throw new Error('渲染次数过多，可能存在无限循环')
    dirty = false
    renderPass()
    // 渲染稳定后跑「已到期」的定时器，再继续收敛。
    if (!dirty) {
      for (const [id, timer] of dueTimers()) {
        timers.delete(id)
        timer.fn()
      }
    }
  }
}

/** 推进虚拟时间（毫秒）并收敛：去抖落盘 300ms、撤销窗口 5000ms 靠它触发。 */
function advance(ms) {
  clock += ms
  flush()
}

function act(mutate) {
  maxPassCardRenders = 0
  mutate()
  flush()
}

/** 派发一次全局 keydown：走组件真正注册在 window 上的监听，而不是直接调组件内部函数。 */
function pressKey(patch) {
  const event = Object.assign({ preventDefault() {}, stopPropagation() {} }, patch)
  for (const listener of (windowListeners.get('keydown') || []).slice()) listener(event)
  flush()
}

function cards() {
  return elements.filter((el) => el.type === 'textarea' && el.props.className === 'dsn-note-input')
}
function cardTexts() {
  return cards().map((el) => el.props.value)
}
// 搜索态下正文是只读高亮视图，不是 textarea：两种形态都算「这条便签显示的文字」。
function noteViews() {
  return elements.filter((el) => el.type === 'div' && el.props.className === 'dsn-note-view')
}
function marks() {
  return elements.filter((el) => el.type === 'mark')
}
function flattenText(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flattenText).join('')
  if (node.props) return flattenText(node.props.children)
  return ''
}
function shownTexts() {
  return elements
    .filter(
      (el) =>
        (el.type === 'textarea' && el.props.className === 'dsn-note-input') ||
        (el.type === 'div' && el.props.className === 'dsn-note-view'),
    )
    .map((el) => (el.type === 'textarea' ? el.props.value : flattenText(el.props.children)))
}
function hint() {
  return elements.find((el) => typeof el.props.className === 'string' && el.props.className.indexOf('dsn-hint') === 0)
}
function draftArea() {
  return elements.find(
    (el) => el.type === 'textarea' && typeof el.props.className === 'string' && el.props.className.indexOf('dsn-draft') !== -1,
  )
}

// ---------------------------------------------------------------- 断言

const failures = []
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures.push(`${name}\n     期望：${JSON.stringify(expected)}\n     实际：${JSON.stringify(actual)}`)
}

flush()

check('初始排序按最近改动降序', cardTexts(), EXPECTED_ORDER)

// 1. 编辑最后一条：打字过程中不许重排
act(() => cards()[2].props.onChange({ target: { value: '旧的一条（改到一半）' } }))
check('编辑途中列表不重排', cardTexts(), ['最新那条', '中间那条', '旧的一条（改到一半）'])
check('打字只重渲染正在编辑的那 1 张卡片', maxPassCardRenders, 1)
act(() => cards()[2].props.onChange({ target: { value: '旧的一条（改完）' } }))
check('连续输入仍然不重排', cardTexts(), ['最新那条', '中间那条', '旧的一条（改完）'])

// 2. 顺序是「手动排的」：编辑 + 失焦都不该打乱它（只更新「最近改动」时间）
act(() => cards()[2].props.onBlur())
check('失焦后顺序不变（编辑不打乱手动顺序）', cardTexts(), ['最新那条', '中间那条', '旧的一条（改完）'])
advance(300)
const afterBlur = JSON.parse(storage.get('dsh-sticky-notes:v1')).notes.find((note) => note.id === 'n-old')
check('失焦仍会更新「最近改动」时间', afterBlur.updatedAt > afterBlur.createdAt, true)

// 2b. 只点进去再点出来（没改过）也不重排
const orderBeforeBlur = cardTexts()
act(() => cards()[2].props.onBlur())
check('没改过就失焦不重排', cardTexts(), orderBeforeBlur)

// 3. 输入法组词中按 Ctrl+Enter 不误存
const countBefore = cards().length
act(() => draftArea().props.onChange({ target: { value: '新想法' } }))
act(() =>
  draftArea().props.onKeyDown({
    nativeEvent: { isComposing: true },
    ctrlKey: true,
    key: 'Enter',
    preventDefault() {},
  }),
)
check('组词中的 Enter 不新增便签', cards().length, countBefore)
check('组词中的 Enter 不清空草稿', draftArea().props.value, '新想法')

// 3b. 组词结束后 Ctrl+Enter 正常记下
act(() =>
  draftArea().props.onKeyDown({
    nativeEvent: { isComposing: false },
    ctrlKey: true,
    key: 'Enter',
    preventDefault() {},
  }),
)
check('组词结束后 Ctrl+Enter 记下一条', cards().length, countBefore + 1)
check('新便签排在最前', cardTexts()[0], '新想法')
check('记下后草稿清空', draftArea().props.value, '')

// 4. 存储写失败：必须显示「保存失败」，不能谎报「已保存」
advance(300)
check('正常情况下提示已保存', hint() && hint().props.children, '已自动保存到本机')
// 这一步会故意触发 QuotaExceededError，把组件自己的 console.warn 静音，免得刷日志
function quiet(fn) {
  const original = console.warn
  console.warn = () => {}
  try {
    fn()
  } finally {
    console.warn = original
  }
}
storageFull = true
quiet(() => act(() => cards()[0].props.onChange({ target: { value: '新想法（存不下）' } })))
quiet(() => advance(300))
check('存储失败时提示保存失败', hint() && hint().props.children, '保存失败，请先导出')
check('失败提示带 is-error 样式', hint() && hint().props.className, 'dsn-hint is-error')
check('失败提示用 role=alert', hint() && hint().props.role, 'alert')
storageFull = false
act(() => cards()[0].props.onChange({ target: { value: '新想法（又能存了）' } }))
advance(300)
check('恢复可写后回到已保存', hint() && hint().props.children, '已自动保存到本机')

// ---------------------------------------------------------------- 搜索与焦点

function searchInput() {
  return elements.find((el) => el.type === 'input' && el.props.className === 'dsn-search-input')
}
function closeButton() {
  return elements.find(
    (el) => el.type === 'button' && el.props.className === 'dsn-icon-btn' && el.props['aria-label'] === '收起便签栏',
  )
}

// 换一套数据重新挂载：搜索框要便签 ≥ 6 条才出现，另外放一条已归档的。
function remount(nextNotes, props) {
  runtimeProps = props || {}
  storage.set('dsh-sticky-notes:v1', JSON.stringify({ notes: nextNotes }))
  storage.set('dsh-sticky-notes:open', '1')
  hookSlots = []
  refSlots = []
  effectSlots = []
  timers.clear()
  // 卸载会移除组件挂在 window 上的监听；重挂载相当于重新开始，旧的不能留。
  windowListeners.clear()
  cursor = 0
  elements = []
  focusedElement = null
  dirty = true
  flush()
}

const ARCHIVED_TEXT = '归档的旧念头：验证搜索能跨视图'
const searchSeed = [
  { id: 's1', text: '买咖啡豆', color: 'amber', pinned: false, createdAt: now - 6000, updatedAt: now - 6000 },
  { id: 's2', text: '周五复盘提纲', color: 'sky', pinned: false, createdAt: now - 5000, updatedAt: now - 5000 },
  { id: 's3', text: '给妈妈打电话', color: 'mint', pinned: false, createdAt: now - 4000, updatedAt: now - 4000 },
  { id: 's4', text: '读《卡片笔记法》', color: 'rose', pinned: false, createdAt: now - 3000, updatedAt: now - 3000 },
  { id: 's5', text: '把抽屉宽度做成可拖', color: 'violet', pinned: false, createdAt: now - 2000, updatedAt: now - 2000 },
  { id: 's6', text: '周三前交稿', color: 'amber', pinned: false, createdAt: now - 1000, updatedAt: now - 1000 },
  {
    id: 's7',
    text: ARCHIVED_TEXT,
    color: 'mint',
    pinned: false,
    archived: true,
    archivedAt: now - 500,
    createdAt: now - 7000,
    updatedAt: now - 7000,
  },
]
remount(searchSeed)

check('便签够多时渲染出搜索框', Boolean(searchInput()), true)
check('「全部」视图默认不列已归档', cardTexts().indexOf(ARCHIVED_TEXT), -1)

act(() => searchInput().props.onChange({ target: { value: '归档' } }))
check('搜索能跨视图命中已归档便签', shownTexts(), [ARCHIVED_TEXT])
check('命中的归档便签带「已归档」标记', elements.some((el) => el.props.className === 'dsn-archived-mark'), true)
check('搜索态下正文渲染成只读视图', cards().length, 0)
check('命中片段用 <mark> 高亮', marks().map((el) => el.props.children), ['归档'])
check('归档便签的只读视图不可点击编辑', noteViews()[0].props.role, undefined)

act(() => searchInput().props.onChange({ target: { value: '' } }))
check('清空搜索回到当前视图', cardTexts().length, 6)
check('清空搜索后没有残留高亮', marks().length, 0)

// 搜索态下点一条 → 只把这一条切回可编辑，其余保持只读高亮
act(() => searchInput().props.onChange({ target: { value: '周' } }))
check('两条便签命中「周」', shownTexts().length, 2)
check('命中片段两处高亮', marks().length, 2)
act(() => noteViews()[0].props.onClick({}))
check('点中的那条切回 textarea', cards().length, 1)
check('其余仍是只读视图', noteViews().length, 1)
check('切回编辑的那条自动聚焦', cards()[0].props.autoFocus, true)
act(() => searchInput().props.onChange({ target: { value: '' } }))
check('清空搜索后全部回到 textarea', cards().length, 6)

// 搜索跨视图，所以标签要同步高亮「全部」，不能出现「已归档标签亮着、结果里却有未归档便签」
function filterTabs() {
  return elements.filter((el) => String(el.props.className || '').indexOf('dsn-filter-btn') !== -1)
}
act(() => filterTabs()[1].props.onClick())
check('切到已归档视图', filterTabs()[1].props['aria-selected'], 'true')
act(() => searchInput().props.onChange({ target: { value: '归档' } }))
check('搜索时「全部」标签高亮', filterTabs()[0].props['aria-selected'], 'true')
check('搜索时「已归档」标签不再高亮', filterTabs()[1].props['aria-selected'], 'false')
check('搜索仍命中归档便签', shownTexts(), [ARCHIVED_TEXT])

// 收起后焦点要还给左边缘标签，键盘用户不会掉到页面开头。
focusedElement = null
act(() => closeButton().props.onClick({}))
check('收起后不再渲染面板', elements.some((el) => el.props.className === 'dsn-panel'), false)
check('收起后焦点回到左边缘标签', focusedElement && focusedElement.props.className, 'dsn-tab')

// 零级进入：展开后光标应该已经在草稿框里（用户不用再点一次输入框）。
function tabButton() {
  return elements.find((el) => el.type === 'button' && el.props.className === 'dsn-tab')
}
focusedElement = null
act(() => tabButton().props.onClick({}))
check('点贴边标签展开面板', elements.some((el) => el.props.className === 'dsn-panel'), true)
check('展开后焦点就在草稿框', focusedElement, draftArea())

// Alt+Shift+N 同理：唤起即写。快捷键走的是 window 上的监听，不是组件内部函数。
act(() => closeButton().props.onClick({}))
focusedElement = null
pressKey({ altKey: true, shiftKey: true, key: 'N' })
check('Alt+Shift+N 展开面板', elements.some((el) => el.props.className === 'dsn-panel'), true)
check('Alt+Shift+N 展开后焦点就在草稿框', focusedElement, draftArea())
pressKey({ altKey: true, shiftKey: true, key: 'n' })
check('再按一次 Alt+Shift+N 收起', elements.some((el) => el.props.className === 'dsn-panel'), false)
check('快捷键收起后焦点也回到贴边标签', focusedElement && focusedElement.props.className, 'dsn-tab')

// ---------------------------------------------------------------- 备份与恢复

function menuButton() {
  return elements.find((el) => el.type === 'button' && String(el.props.className || '').indexOf('dsn-more') !== -1)
}
function menuItems() {
  return elements.filter((el) => el.type === 'button' && el.props.className === 'dsn-menu-item')
}
function fileInput() {
  return elements.find((el) => el.type === 'input' && el.props.className === 'dsn-file')
}
function toastEl() {
  return elements.find((el) => el.type === 'div' && String(el.props.className || '').indexOf('dsn-toast') === 0)
}
function toastUndo() {
  return elements.find((el) => el.type === 'button' && el.props.className === 'dsn-toast-undo')
}
function fakeFile(text) {
  return { name: 'backup.json', type: 'application/json', text: () => Promise.resolve(text) }
}
async function actAsync(work) {
  await work()
  // 让 file.text() / Promise 链跑完，再收敛渲染。
  await new Promise((resolve) => setImmediate(resolve))
  flush()
}

const roundTripSeed = [
  { id: 'r1', text: '第一条', color: 'sky', pinned: true, createdAt: now - 4000, updatedAt: now - 4000 },
  { id: 'r2', text: '第二条', color: 'rose', pinned: false, archived: true, archivedAt: now - 3000, createdAt: now - 3000, updatedAt: now - 3000 },
]
remount(roundTripSeed)

act(() => menuButton().props.onClick({}))
check('「更多」菜单有三项（备份 / 恢复 / 重排）', menuItems().length, 3)

// 导出 → 清空 → 导入，字段要一模一样
await actAsync(() => menuItems()[0].props.onClick({}))
const exported = await lastBlob.text()
const exportedNotes = JSON.parse(exported).notes
check('导出的备份带格式标记', JSON.parse(exported).format, 'dsh-sticky-notes-backup')
check('导出包含全部便签（含归档）', exportedNotes.length, 2)

remount([])
check('清空后没有便签', cardTexts().length, 0)
await actAsync(() => fileInput().props.onChange({ target: { files: [fakeFile(exported)] } }))
advance(300)
check('导入后「全部」列表只显示未归档的 1 条', cardTexts().length, 1)
const storedAfterImport = JSON.parse(storage.get('dsh-sticky-notes:v1')).notes
check('导入后存储里是 2 条（含归档）', storedAfterImport.length, 2)
const shape = (list) =>
  list
    .map((note) => [note.id, note.text, note.color, !!note.pinned, !!note.archived, note.updatedAt])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
check('导入结果与备份文件逐字段一致', shape(storedAfterImport), shape(exportedNotes))

// 合并：同 id 取较新的，不同 id 追加
const mergeSeed = [
  { id: 'm1', text: '甲', color: 'amber', pinned: false, createdAt: now - 5000, updatedAt: now - 5000 },
  { id: 'm2', text: '乙', color: 'mint', pinned: false, createdAt: now - 4000, updatedAt: now - 4000 },
]
remount(mergeSeed)
const mergeBackup = JSON.stringify({
  format: 'dsh-sticky-notes-backup',
  version: 1,
  notes: [
    { id: 'm1', text: '甲（备份里更新）', color: 'amber', pinned: false, createdAt: now - 5000, updatedAt: now - 1000 },
    { id: 'm3', text: '丙（备份里新增）', color: 'violet', pinned: false, createdAt: now - 900, updatedAt: now - 900 },
  ],
})
await actAsync(() => fileInput().props.onChange({ target: { files: [fakeFile(mergeBackup)] } }))
check('合并后共 3 条', cardTexts().length, 3)
check('同 id 取较新的内容', cardTexts().indexOf('甲（备份里更新）'), 1)
check('旧内容被新内容替换', cardTexts().indexOf('甲'), -1)
check('不同 id 追加进来（按改动时间排最前）', cardTexts()[0], '丙（备份里新增）')
check('提示条报导入条数', toastEl() && toastEl().props.children[0].props.children, '已导入 1 条 · 更新 1 条')

// 导入可撤销：整份换回导入前
act(() => toastUndo().props.onClick({}))
check('撤销导入回到导入前', cardTexts().length, 2)
check('撤销后内容回到原样', cardTexts().slice().sort(), ['乙', '甲'].sort())

// 非法文件 / 空备份：明确报错，且不动数据
await actAsync(() => fileInput().props.onChange({ target: { files: [fakeFile('这不是 JSON')] } }))
check('非法备份给错误提示', toastEl() && toastEl().props.children[0].props.children, '不是本插件的备份文件')
check('错误提示带 is-error', toastEl() && toastEl().props.className, 'dsn-toast is-error')
check('非法备份不动现有数据', cardTexts().length, 2)

await actAsync(() => fileInput().props.onChange({ target: { files: [fakeFile(JSON.stringify({ notes: [] }))] } }))
check('空备份给错误提示', toastEl() && toastEl().props.children[0].props.children, '备份文件里没有便签')
check('空备份不动现有数据', cardTexts().length, 2)

// ---------------------------------------------------------------- 会话绑定

// 模拟 slot 的标准 kit：useSessions 是 selector hook，返回「主视图当前会话」。
let fakeActiveSession = 'ses-A'
function sessionState() {
  return {
    byId: {
      'ses-A': { id: 'ses-A', title: '会话 A 的标题', retainedBy: { mainView: fakeActiveSession === 'ses-A' ? 1 : 0 } },
      'ses-B': { id: 'ses-B', title: '会话 B 的标题', retainedBy: { mainView: fakeActiveSession === 'ses-B' ? 1 : 0 } },
    },
  }
}
const kit = { useSessions: (selector) => selector(sessionState()) }

function filterChips() {
  return elements.filter((el) => el.type === 'button' && String(el.props.className || '').indexOf('dsn-filter-btn') !== -1)
}
function noteTextsInStorage() {
  return JSON.parse(storage.get('dsh-sticky-notes:v1')).notes
}

const legacyNote = { id: 'legacy', text: '老便签（没有会话信息）', color: 'amber', pinned: false, createdAt: now - 9000, updatedAt: now - 9000 }
fakeActiveSession = 'ses-A'
remount([legacyNote], kit)
check('拿到会话 id 时出现「本会话」标签', filterChips().length, 3)
check('本会话标签文案带条数', String(filterChips()[1].props.children), '本会话 0')

// 在会话 A 里记一条
act(() => draftArea().props.onChange({ target: { value: '记在会话 A' } }))
act(() => draftArea().props.onKeyDown({ nativeEvent: { isComposing: false }, ctrlKey: true, key: 'Enter', preventDefault() {} }))
advance(300)
check('新便签带上当前会话 id', noteTextsInStorage().find((note) => note.text === '记在会话 A').sessionId, 'ses-A')

// 切到会话 B，再记一条
fakeActiveSession = 'ses-B'
flush()
act(() => draftArea().props.onChange({ target: { value: '记在会话 B' } }))
act(() => draftArea().props.onKeyDown({ nativeEvent: { isComposing: false }, ctrlKey: true, key: 'Enter', preventDefault() {} }))
advance(300)
check('切会话后新便签跟着换 id', noteTextsInStorage().find((note) => note.text === '记在会话 B').sessionId, 'ses-B')

// 「本会话」视图只显示当前会话的便签
check('本会话标签计数跟着走', String(filterChips()[1].props.children), '本会话 1')
act(() => filterChips()[1].props.onClick({}))
check('本会话视图只显示会话 B 的便签', cardTexts(), ['记在会话 B'])

// 切回会话 A，同一视图自动切换
fakeActiveSession = 'ses-A'
flush()
check('切回会话 A 后本会话视图自动更新', cardTexts(), ['记在会话 A'])

// 全部视图仍然能看到所有便签（含没有会话信息的老便签）
act(() => filterChips()[0].props.onClick({}))
check('全部视图包含老便签与两个会话的便签', cardTexts().slice().sort(), ['记在会话 A', '记在会话 B', '老便签（没有会话信息）'].sort())

// 没拿到 kit 时不该出现「本会话」标签（降级成一个纯本地便签栏）
remount([legacyNote])
check('没有 kit 时只有 2 个标签', filterChips().length, 2)

// ---------------------------------------------------------------- 来源会话
//
// 便签里存着「写在哪个会话里」：「全部」视图要能看出来自别的会话，点一下跳回那个会话
// （走宿主 uiWorkspace.openSession）。宿主服务缺失时如实提示，不静默失败。

function sourceChips() {
  return elements.filter((el) => String(el.props.className || '') === 'dsn-source')
}

const sourceSeed = [
  { id: 'src-a', text: '写在会话 A 的想法', color: 'amber', pinned: false, sessionId: 'ses-A', createdAt: now - 3000, updatedAt: now - 3000 },
  { id: 'src-b', text: '写在会话 B 的想法', color: 'sky', pinned: false, sessionId: 'ses-B', createdAt: now - 2000, updatedAt: now - 2000 },
  { id: 'src-none', text: '没有会话信息的老便签', color: 'mint', pinned: false, createdAt: now - 1000, updatedAt: now - 1000 },
]

fakeActiveSession = 'ses-B'
fakeUiWorkspace = null
remount(sourceSeed, kit)
check('只给「别的会话里写的」便签标来源', sourceChips().length, 1)
check('来源标签显示那个会话的标题', flattenText(sourceChips()[0].props.children), '会话 A 的标题')

remount(sourceSeed)
check('没有 kit 时不标来源（无从判断哪个是当前会话）', sourceChips().length, 0)

// 宿主有 uiWorkspace：点来源直接跳回去
const jumped = []
fakeUiWorkspace = { openSession: (id) => jumped.push(id) }
remount(sourceSeed, kit)
act(() => sourceChips()[0].props.onClick({ stopPropagation() {} }))
check('点来源跳到写这条便签的会话', jumped, ['ses-A'])
check('跳转成功不弹失败提示', toastEl(), undefined)

// 会话已不在列表里（被删 / 换了工作区）：标题退回「其他会话」，但照样能试着跳
const orphanSeed = [
  { id: 'orphan', text: '来自已删除会话', color: 'amber', pinned: false, sessionId: 'ses-gone', createdAt: now, updatedAt: now },
]
remount(orphanSeed, kit)
check('会话查不到时标题退回「其他会话」', flattenText(sourceChips()[0].props.children), '其他会话')

// 宿主没这个服务（老版本）：点下去要如实说一句，而不是毫无反应
fakeUiWorkspace = null
remount(sourceSeed, kit)
act(() => sourceChips()[0].props.onClick({ stopPropagation() {} }))
check('没有 uiWorkspace 时如实提示', toastEl() && toastEl().props.children[0].props.children, '打不开那个会话')

// ---------------------------------------------------------------- 草稿与复制

function copyButton() {
  return elements.find((el) => el.type === 'button' && String(el.props.className || '').indexOf('dsn-copy') !== -1)
}

// 草稿要活过「刷新」：没按「记下」的半句话也不能丢。
storage.delete('dsh-sticky-notes:draft')
remount([])
act(() => draftArea().props.onChange({ target: { value: '还没写完的半句话' } }))
check('草稿写进本地存储', storage.get('dsh-sticky-notes:draft'), '还没写完的半句话')
remount([]) // 相当于刷新页面：组件重新挂载
check('刷新后草稿还在', draftArea().props.value, '还没写完的半句话')
act(() => draftArea().props.onKeyDown({ nativeEvent: { isComposing: false }, ctrlKey: true, key: 'Enter', preventDefault() {} }))
advance(300)
check('记下之后草稿被清掉', storage.has('dsh-sticky-notes:draft'), false)

// 一键复制：成功给提示，失败如实报错
const copySeed = [{ id: 'cp', text: '要被复制的一句话', color: 'amber', pinned: false, createdAt: now - 1000, updatedAt: now - 1000 }]
remount(copySeed)
clipboardText = null
await actAsync(() => copyButton().props.onClick({}))
check('复制把正文写进剪贴板', clipboardText, '要被复制的一句话')
check('复制成功给提示', toastEl() && toastEl().props.children[0].props.children, '已复制这条便签')

clipboardFail = true
await actAsync(() => copyButton().props.onClick({}))
check('复制失败如实报错', toastEl() && toastEl().props.children[0].props.children, '复制失败，请手动选择文本')
check('失败提示带 is-error', toastEl() && toastEl().props.className, 'dsn-toast is-error')
clipboardFail = false

// ---------------------------------------------------------------- 收起时的角标
//
// 收起后只剩 32px 的贴边标签，所以「有草稿没记下」「有几条置顶」都得从这个标签上读出来；
// 语义同时写进 title / aria-label，不依赖颜色。

function tabDraftDot() {
  return elements.find((el) => el.props.className === 'dsn-tab-draft')
}
function tabPinMark() {
  return elements.find((el) => el.props.className === 'dsn-tab-pin')
}
function tabCount() {
  return elements.find((el) => el.props.className === 'dsn-tab-count')
}

storage.delete('dsh-sticky-notes:draft')
const badgeSeed = [
  { id: 'b1', text: '被钉住的那条', color: 'amber', pinned: true, createdAt: now - 2000, updatedAt: now - 2000 },
  { id: 'b2', text: '普通的那条', color: 'sky', pinned: false, createdAt: now - 1000, updatedAt: now - 1000 },
]
remount(badgeSeed)
act(() => closeButton().props.onClick({}))
check('收起后显示总数角标', tabCount() && tabCount().props.children, '2')
check('有置顶时收起态显示置顶标记', Boolean(tabPinMark()), true)
check('没有草稿时不出草稿点', tabDraftDot(), undefined)
check('置顶条数写进贴边标签 title', String(tabButton().props.title).indexOf('1 置顶') !== -1, true)

// 写了没记下 → 收起后留一个草稿点：不打开面板也知道有东西没存
act(() => tabButton().props.onClick({}))
act(() => draftArea().props.onChange({ target: { value: '写了一半还没记下' } }))
act(() => closeButton().props.onClick({}))
check('有草稿时收起态出现草稿点', Boolean(tabDraftDot()), true)
check('草稿状态写进 aria-label', String(tabButton().props['aria-label']).indexOf('有草稿还没记下') !== -1, true)

// 记下之后草稿点消失
act(() => tabButton().props.onClick({}))
act(() => draftArea().props.onKeyDown({ nativeEvent: { isComposing: false }, ctrlKey: true, key: 'Enter', preventDefault() {} }))
advance(300)
act(() => closeButton().props.onClick({}))
check('记下后草稿点消失', tabDraftDot(), undefined)

// ---------------------------------------------------------------- 手动排序

function articles() {
  return elements.filter((el) => el.type === 'article')
}
function grips() {
  return elements.filter((el) => el.type === 'button' && el.props.className === 'dsn-grip')
}

const reorderSeed = [
  { id: 'r-first', text: '第一条', color: 'amber', pinned: false, createdAt: now - 1000, updatedAt: now - 1000 },
  { id: 'r-second', text: '第二条', color: 'sky', pinned: false, createdAt: now - 2000, updatedAt: now - 2000 },
  { id: 'r-third', text: '第三条', color: 'mint', pinned: false, createdAt: now - 3000, updatedAt: now - 3000 },
]
remount(reorderSeed)

check('排序前顺序', cardTexts(), ['第一条', '第二条', '第三条'])
check('每张卡片都有拖动把手', grips().length, 3)

// 拖动：把第一条拖到第三条的下半部分 → 插到它后面
act(() =>
  grips()[0].props.onDragStart({
    currentTarget: grips()[0],
    dataTransfer: { effectAllowed: '', setData() {} },
  }),
)
act(() =>
  articles()[2].props.onDrop({ preventDefault() {}, currentTarget: articles()[2], clientY: 90 }),
)
check('拖到第三条后面', cardTexts(), ['第二条', '第三条', '第一条'])

// 拖到上半部分 → 插到它前面
act(() => grips()[2].props.onDragStart({ currentTarget: grips()[2], dataTransfer: { setData() {} } }))
act(() => articles()[0].props.onDrop({ preventDefault() {}, currentTarget: articles()[0], clientY: 10 }))
check('拖到第一条前面', cardTexts(), ['第一条', '第二条', '第三条'])

// 键盘等价操作：把手聚焦后按 ↑/↓
act(() => grips()[1].props.onKeyDown({ key: 'ArrowUp', preventDefault() {} }))
check('键盘 ↑ 上移一格', cardTexts(), ['第二条', '第一条', '第三条'])
act(() => grips()[0].props.onKeyDown({ key: 'ArrowDown', preventDefault() {} }))
check('键盘 ↓ 下移一格', cardTexts(), ['第一条', '第二条', '第三条'])

// 落盘后 order 必须和视觉顺序一致；新便签永远落最上面
advance(300)
const storedAfterReorder = JSON.parse(storage.get('dsh-sticky-notes:v1')).notes
const byOrder = storedAfterReorder
  .slice()
  .sort((a, b) => a.order - b.order)
  .map((note) => note.text)
check('落盘的 order 与视觉顺序一致', byOrder, cardTexts())
const orderValues = storedAfterReorder.map((note) => note.order)
check('order 都是数字', orderValues.every((value) => typeof value === 'number' && isFinite(value)), true)

act(() => draftArea().props.onChange({ target: { value: '刚记的' } }))
act(() => draftArea().props.onKeyDown({ nativeEvent: { isComposing: false }, ctrlKey: true, key: 'Enter', preventDefault() {} }))
check('手动排过之后新便签仍落在最上面', cardTexts()[0], '刚记的')
advance(300)
const afterAdd = JSON.parse(storage.get('dsh-sticky-notes:v1')).notes

// 「重排：按最近改动」把顺序复位成时间序
act(() => grips()[0].props.onDragStart({ currentTarget: grips()[0], dataTransfer: { setData() {} } }))
act(() => articles()[3].props.onDrop({ preventDefault() {}, currentTarget: articles()[3], clientY: 90 }))
check('先手动拖乱', cardTexts()[0] !== '刚记的', true)
act(() => menuButton().props.onClick({}))
act(() => menuItems()[2].props.onClick({}))
check('按最近改动重排后最新写在最上面', cardTexts()[0], '刚记的')

check('新便签的 order 比所有人都小', Math.min(...afterAdd.map((note) => note.order)) === afterAdd.find((note) => note.text === '刚记的').order, true)

// ---------------------------------------------------------------- 结果

if (failures.length > 0) {
  console.error('FAIL')
  for (const failure of failures) console.error(' - ' + failure)
  process.exit(1)
}
console.log(
  'PASS  行为测试：编辑不重排 / 失焦只更新时间 / 组词不误存 / 落盘失败如实提示 / 搜索跨视图 + 命中高亮 / 收起还焦点 / 唤起即聚焦 / 收起态角标（草稿 + 置顶）/ 备份 round-trip / 合并撤销 / 会话绑定 / 来源会话跳转 / 草稿不丢 / 一键复制 / 拖动排序 + 键盘移动',
)
