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

function createElement(type, rawProps, ...children) {
  const props = Object.assign({}, rawProps || {})
  if (children.length === 1) props.children = children[0]
  else if (children.length > 1) props.children = children
  if (typeof type === 'function') {
    if (type.prototype && typeof type.prototype.render === 'function') return new type(props).render()
    return type(props)
  }
  const element = { type, props, style: {}, scrollHeight: 0, setAttribute() {}, appendChild() {}, remove() {} }
  // 和 React 一样：DOM 元素的 ref 指向元素本身；给个 focus 用来验证焦点归还。
  if (props.ref && typeof props.ref === 'object') {
    props.ref.current = element
    element.focus = () => {
      focusedElement = element
    }
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
  useMemo(factory) {
    return factory()
  },
  useCallback(fn) {
    return fn
  },
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
    addEventListener: () => {},
    removeEventListener: () => {},
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
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
}

vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

// ---------------------------------------------------------------- 挂载组件

let registered = null
const ctx = {
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
  elements = []
  pendingEffects = []
  registered.component()
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
  mutate()
  flush()
}

function cards() {
  return elements.filter((el) => el.type === 'textarea' && el.props.className === 'dsn-note-input')
}
function cardTexts() {
  return cards().map((el) => el.props.value)
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
act(() => cards()[2].props.onChange({ target: { value: '旧的一条（改完）' } }))
check('连续输入仍然不重排', cardTexts(), ['最新那条', '中间那条', '旧的一条（改完）'])

// 2. 失焦才置顶
act(() => cards()[2].props.onBlur())
check('失焦后刚改的便签排到最前', cardTexts(), ['旧的一条（改完）', '最新那条', '中间那条'])

// 2b. 只点进去再点出来（没改过）不许重排
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
function remount(nextNotes) {
  storage.set('dsh-sticky-notes:v1', JSON.stringify({ notes: nextNotes }))
  storage.set('dsh-sticky-notes:open', '1')
  hookSlots = []
  refSlots = []
  effectSlots = []
  timers.clear()
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
check('搜索能跨视图命中已归档便签', cardTexts(), [ARCHIVED_TEXT])
check('命中的归档便签带「已归档」标记', elements.some((el) => el.props.className === 'dsn-archived-mark'), true)
check('归档命中项仍是只读', cards()[0].props.readOnly, true)

act(() => searchInput().props.onChange({ target: { value: '' } }))
check('清空搜索回到当前视图', cardTexts().length, 6)

// 搜索跨视图，所以标签要同步高亮「全部」，不能出现「已归档标签亮着、结果里却有未归档便签」
function filterTabs() {
  return elements.filter((el) => String(el.props.className || '').indexOf('dsn-filter-btn') !== -1)
}
act(() => filterTabs()[1].props.onClick())
check('切到已归档视图', filterTabs()[1].props['aria-selected'], 'true')
act(() => searchInput().props.onChange({ target: { value: '归档' } }))
check('搜索时「全部」标签高亮', filterTabs()[0].props['aria-selected'], 'true')
check('搜索时「已归档」标签不再高亮', filterTabs()[1].props['aria-selected'], 'false')
check('搜索仍命中归档便签', cardTexts(), [ARCHIVED_TEXT])

// 收起后焦点要还给左边缘标签，键盘用户不会掉到页面开头。
focusedElement = null
act(() => closeButton().props.onClick({}))
check('收起后不再渲染面板', elements.some((el) => el.props.className === 'dsn-panel'), false)
check('收起后焦点回到左边缘标签', focusedElement && focusedElement.props.className, 'dsn-tab')

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
check('「更多」菜单有两个备份项', menuItems().length, 2)

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

// ---------------------------------------------------------------- 结果

if (failures.length > 0) {
  console.error('FAIL')
  for (const failure of failures) console.error(' - ' + failure)
  process.exit(1)
}
console.log(
  'PASS  行为测试：编辑不重排 / 失焦才置顶 / 组词不误存 / 落盘失败如实提示 / 搜索跨视图 / 收起还焦点 / 备份导出导入 round-trip / 合并与撤销',
)
