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
let sandboxNow = Date.now()
let timers = new Map()
let timerSeq = 0
let focusedElement = null
let lastBlob = null
// 剪贴板：测试里捕获写进去的文本，也能模拟被拒绝。
let clipboardText = null
let clipboardFail = false
// 语音：假 fetch（catalog / transcribe）、假麦克风与假 MediaRecorder / AudioContext。
let voiceCatalogPayload = {
  ok: true,
  catalog: {
    available: true,
    reason: '',
    providerId: 'sensevoice',
    location: 'host-local',
    preparation: 'ready',
    language: 'auto',
    limits: { maxDurationSeconds: 60, maxAudioBytes: 2 * 1024 * 1024 },
  },
}
let voiceTranscribePayload = { ok: true, text: '语音识别出的文本', audioSeconds: 2, inferenceSeconds: 0.1 }
// 模拟「本机模型冷启动、转写迟迟不返回」：设成一个 Promise，转写请求会等它 resolve。
let voiceTranscribeDelay = null
let voiceFetchCalls = []
let micError = null
let micStreamStopped = 0
// 假麦克风电平：模拟「说话」0.4 / 静音 0，用来测电平条和静音自动停。
let fakeVoiceLevel = 0
// 组件收到的 props：真环境里是 slot 的标准 kit（含 useSessions），测试里可以模拟。
let runtimeProps = {}
// 每个渲染 pass 真正渲染了几张卡片：用来验证 memo 生效（打字只该重渲染 1 张）。
let passCardRenders = 0
let maxPassCardRenders = 0
// 挂在 window 上的 keydown 监听也要能真触发：Alt+Shift+N / Esc / Ctrl+K 都走这条路。
const windowListeners = new Map()
// document 上的监听（面板内粘贴、点外面收起）：粘贴捕获要能真的派发，所以也记录下来。
const documentListeners = new Map()
function addDocumentListener(type, fn) {
  const list = documentListeners.get(type) || []
  list.push(fn)
  documentListeners.set(type, list)
}
function removeDocumentListener(type, fn) {
  const list = documentListeners.get(type)
  if (!list) return
  const index = list.indexOf(fn)
  if (index !== -1) list.splice(index, 1)
}
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

// 语音：假音频管线（不解码真音频，只保证「录音 → 重采样 → WAV → base64」状态机跑通）。
class FakeAnalyser {
  constructor() {
    this.fftSize = 256
  }
  getFloatTimeDomainData(target) {
    for (let i = 0; i < target.length; i += 1) target[i] = fakeVoiceLevel
  }
}
class FakeAudioContext {
  constructor() {
    this.state = 'running'
  }
  createAnalyser() {
    return new FakeAnalyser()
  }
  createMediaStreamSource() {
    return { connect() {} }
  }
  decodeAudioData() {
    return Promise.resolve({ duration: 2 })
  }
  close() {
    this.state = 'closed'
    return Promise.resolve()
  }
}
class FakeOfflineAudioContext {
  constructor(channels, length, sampleRate) {
    this.length = length
    this.sampleRate = sampleRate
    this.destination = {}
  }
  createBufferSource() {
    return { buffer: null, connect() {}, start() {} }
  }
  startRendering() {
    const data = new Float32Array(Math.min(this.length || 32000, 32000))
    data[0] = 0.2
    return Promise.resolve({ getChannelData: () => data })
  }
}
class FakeMediaRecorder {
  constructor(stream) {
    this.stream = stream
    this.state = 'inactive'
    this.mimeType = 'audio/webm'
    this.ondataavailable = null
    this.onstop = null
    this.onerror = null
  }
  start() {
    this.state = 'recording'
    if (this.ondataavailable) this.ondataavailable({ data: { size: 64 } })
  }
  stop() {
    this.state = 'inactive'
    if (this.onstop) this.onstop()
  }
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
    // 编辑态高度上限按视口 60% 算：900 * 0.6 = 540px，测试里能断言具体的展开高度。
    innerHeight: 900,
    AudioContext: FakeAudioContext,
    OfflineAudioContext: FakeOfflineAudioContext,
    setInterval: (fn, delay) => {
      timerSeq += 1
      timers.set(timerSeq, { fn, at: clock + (typeof delay === 'number' ? delay : 0), every: typeof delay === 'number' ? delay : 0 })
      return timerSeq
    },
    clearInterval: (id) => {
      timers.delete(id)
    },
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
    addEventListener: addDocumentListener,
    removeEventListener: removeDocumentListener,
    querySelector: (selector) => {
      if (selector === '[data-dsh-sidebar-root]') return { getBoundingClientRect: () => ({ right: 248 }) }
      // 组件里用 document.querySelector('[data-dsn-note="id"] textarea') 找正文（铅笔入口聚焦）。
      // 假 DOM 没有节点树：卡片文章节点和正文按渲染顺序各排一列，两边都是便签顺序，按下标配对即可。
      const match = /^\[data-dsn-note="([^"]+)"\] textarea$/.exec(String(selector))
      if (!match) return null
      const articleIds = elements.filter((el) => el.type === 'article').map((el) => el.props['data-dsn-note'])
      const index = articleIds.indexOf(match[1])
      if (index === -1) return null
      const textareas = elements.filter((el) => el.type === 'textarea' && el.props.className === 'dsn-note-input')
      return textareas[index] || null
    },
  },
  // 组件里所有 Date.now() 都跟着虚拟时钟走：这样「30 秒心跳」「打开一会儿再记下」
  // 这类相对时间相关路径才能被测到，而不是依赖真机上两毫秒的差。
  Date: class VirtualDate extends Date {
    static now() {
      return sandboxNow + clock
    }
  },
  Blob: class Blob {
    constructor(parts, options) {
      this.parts = parts || []
      this.type = options && options.type
      this.size = this.parts.reduce((sum, part) => sum + ((part && part.size) || 0), 0)
      lastBlob = this
    }
    text() {
      return Promise.resolve(this.parts.join(''))
    }
    arrayBuffer() {
      return Promise.resolve(new ArrayBuffer(8))
    }
  },
  // 语音录音需要：btoa、MediaRecorder、假麦克风、同源 fetch（catalog / transcribe）。
  btoa: (binary) => Buffer.from(binary, 'binary').toString('base64'),
  MediaRecorder: FakeMediaRecorder,
  fetch: (url, init) => {
    const target = String(url)
    voiceFetchCalls.push({ url: target, init })
    if (target.indexOf('/voice/catalog') !== -1) return Promise.resolve({ json: () => Promise.resolve(voiceCatalogPayload) })
    if (target.indexOf('/voice/transcribe') !== -1) {
      const respond = () => Promise.resolve({ json: () => Promise.resolve(voiceTranscribePayload) })
      return voiceTranscribeDelay ? Promise.resolve(voiceTranscribeDelay).then(respond) : respond()
    }
    return Promise.reject(new Error('unexpected fetch: ' + target))
  },
  navigator: {
    clipboard: {
      writeText(text) {
        if (clipboardFail) return Promise.reject(new Error('denied'))
        clipboardText = String(text)
        return Promise.resolve()
      },
      // 菜单档「从剪贴板记下」会先读再填草稿：测试里读的是同一个变量。
      readText() {
        if (clipboardFail) return Promise.reject(new Error('denied'))
        return Promise.resolve(clipboardText == null ? '' : String(clipboardText))
      },
    },
    mediaDevices: {
      getUserMedia() {
        if (micError) return Promise.reject(micError)
        return Promise.resolve({
          getTracks: () => [
            {
              stop() {
                micStreamStopped += 1
              },
            },
          ],
        })
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
        // setInterval 的替身：跑完再按同一周期挂回去（相对时间 30 秒心跳要用）。
        if (timer.every > 0) timers.set(id, { fn: timer.fn, at: timer.at + timer.every, every: timer.every })
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

/** 派发一次 document paste：焦点不在输入框时插件才接管（快捷档直接成便签）。 */
function dispatchPaste({ target = null, text = '' } = {}) {
  const event = {
    target,
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true
    },
    clipboardData: { getData: (kind) => (kind === 'text/plain' ? text : '') },
  }
  for (const listener of (documentListeners.get('paste') || []).slice()) listener(event)
  flush()
  return event
}

/** 派发一次 window storage 事件：模拟「另一个标签页刚写完 notes」。 */
function dispatchStorage() {
  for (const listener of (windowListeners.get('storage') || []).slice()) listener({ key: 'dsh-sticky-notes:v1' })
  flush()
}
function writeStorageNotes(list) {
  storage.set('dsh-sticky-notes:v1', JSON.stringify({ notes: list }))
}
function noteButtons(className) {
  return elements.filter((el) => el.type === 'button' && el.props.className === className)
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

// ---------------------------------------------------------------- 重新编辑
//
// 已保存便签点铅笔 / 点正文即可再改；编辑中卡片高亮 + 「编辑中 · Esc 取消」；
// Esc 恢复进入编辑前的原文且不收起面板；长便签编辑时高度上限放宽到视口 60%。

const editSeed = [
  { id: 'e1', text: '会被重新编辑的一条', color: 'amber', pinned: false, createdAt: now - 1000, updatedAt: now - 1000 },
  { id: 'e2', text: '第二条', color: 'sky', pinned: false, createdAt: now - 2000, updatedAt: now - 2000 },
  { id: 'e3', text: '第三条', color: 'mint', pinned: false, createdAt: now - 3000, updatedAt: now - 3000 },
]
remount(editSeed)

function editButtons() {
  return elements.filter((el) => el.type === 'button' && el.props.className === 'dsn-icon-btn dsn-edit')
}
function editHint() {
  return elements.find((el) => el.props.className === 'dsn-edit-hint')
}
/** 派发一次正文 focusin：模拟用户直接点到正文里（组件用 document 事件委托跟踪编辑态）。 */
function focusinNote(id) {
  const card = { getAttribute: () => id }
  const target = { tagName: 'TEXTAREA', closest: (selector) => (selector === '[data-dsn-note]' ? card : null) }
  for (const listener of (documentListeners.get('focusin') || []).slice()) listener({ target })
  flush()
}

check('非归档便签都有「编辑」入口', editButtons().length, 3)
const firstEdit = editButtons()[0]
check('编辑入口带读屏文案', firstEdit && firstEdit.props['aria-label'], '编辑这条便签')
check('默认没有「编辑中」提示', Boolean(editHint()), false)

focusedElement = null
act(() => {
  if (firstEdit) firstEdit.props.onClick()
})
check('点编辑入口后焦点落到正文', focusedElement && focusedElement.props.className, 'dsn-note-input')
check('进入编辑态有明确提示', editHint() && flattenText(editHint().props.children), '编辑中 · Esc 取消')

// 长便签：编辑态高度上限 = 视口 60%（900 * 0.6 = 540），退出编辑回到 420 预览
const longInput = cards()[0]
longInput.scrollHeight = 1200
if (typeof longInput.props.onFocus === 'function') act(() => longInput.props.onFocus({ target: longInput }))
check('编辑时长正文可以展开到 60vh', longInput.style.height, '540px')
if (typeof longInput.props.onBlur === 'function') act(() => longInput.props.onBlur({ target: longInput }))
check('退出编辑回到 420px 预览', longInput.style.height, '420px')

// 改到一半按 Esc：恢复进入编辑前的原文，面板不收起，也不把半截文本写进存储
remount(editSeed)
focusinNote('e1')
act(() => cards()[0].props.onChange({ target: { value: '会被重新编辑的一条（改到一半）' } }))
check('改动先进入界面', cards()[0].props.value, '会被重新编辑的一条（改到一半）')
pressKey({ key: 'Escape' })
check('Esc 取消编辑：恢复原文', cards()[0] ? cards()[0].props.value : null, '会被重新编辑的一条')
check('Esc 取消后提示消失', Boolean(editHint()), false)
check('Esc 取消编辑不会收起面板', elements.some((el) => el.props.className === 'dsn-panel'), true)
advance(300)
check('半截文本没有落盘', JSON.parse(storage.get('dsh-sticky-notes:v1')).notes.find((note) => note.id === 'e1').text, '会被重新编辑的一条')

// 直接点正文（focusin 委托路径）也算进入编辑；Esc 同样能取消
remount(editSeed)
focusinNote('e2')
check('点正文进入编辑态', Boolean(editHint()), true)
act(() => cards()[1].props.onChange({ target: { value: '第二条（改到一半）' } }))
pressKey({ key: 'Escape' })
check('点正文进入的编辑也能 Esc 取消', cards()[1] ? cards()[1].props.value : null, '第二条')
check('取消后面板还在（Esc 分层）', elements.some((el) => el.props.className === 'dsn-panel'), true)
pressKey({ key: 'Escape' })
check('再按 Esc 才收起面板', elements.some((el) => el.props.className === 'dsn-panel'), false)

// 失焦 = 保存（和原来的自动保存体感一致）
remount(editSeed)
const saveEdit = editButtons()[0]
act(() => {
  if (saveEdit) saveEdit.props.onClick()
})
act(() => cards()[0].props.onChange({ target: { value: '会被重新编辑的一条（保存）' } }))
act(() => cards()[0].props.onBlur({ target: cards()[0] }))
advance(300)
check('编辑后失焦即保存', JSON.parse(storage.get('dsh-sticky-notes:v1')).notes.find((note) => note.id === 'e1').text, '会被重新编辑的一条（保存）')

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
// openState 默认 '1'（真机退出时保留上次开合；默认测试都从展开态开始），
// 传 '0' 可以覆盖「页面加载时面板是收起」这条真实路径。
function remount(nextNotes, props, openState) {
  runtimeProps = props || {}
  storage.set('dsh-sticky-notes:v1', JSON.stringify({ notes: nextNotes }))
  storage.set('dsh-sticky-notes:open', openState === undefined ? '1' : String(openState))
  hookSlots = []
  refSlots = []
  effectSlots = []
  timers.clear()
  // 卸载会移除组件挂在 window / document 上的监听；重挂载相当于重新开始，旧的不能留。
  windowListeners.clear()
  documentListeners.clear()
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

// ---------------------------------------------------------------- 标签搜索
//
// 没有标签表、没有新字段：标签就是正文里的 `#xxx`，现解析。
// `#` 开头的词按标签筛（前缀匹配），其余词按正文，多个条件 AND。

const tagSeed = [
  { id: 't1', text: '#想法 把便签栏做成可折叠的', color: 'amber', createdAt: now - 6000, updatedAt: now - 6000 },
  { id: 't2', text: '#想法 #待办 周五前给设计稿', color: 'sky', createdAt: now - 5000, updatedAt: now - 5000 },
  { id: 't3', text: '#读书 《卡片笔记法》第三章', color: 'mint', createdAt: now - 4000, updatedAt: now - 4000 },
  { id: 't4', text: '没有标签的一条普通便签', color: 'rose', createdAt: now - 3000, updatedAt: now - 3000 },
  { id: 't5', text: '#Deploy 发布前确认回滚方案', color: 'violet', createdAt: now - 2000, updatedAt: now - 2000 },
  {
    id: 't6',
    text: '归档的一条 #想法',
    color: 'mint',
    archived: true,
    archivedAt: now - 1000,
    createdAt: now - 7000,
    updatedAt: now - 7000,
  },
]
function sortedShown() {
  return shownTexts().slice().sort()
}
function emptyTitle() {
  const el = elements.find((node) => node.props.className === 'dsn-empty-title')
  return el && el.props.children
}

remount(tagSeed)
check('便签够多时出现搜索框（标签用例）', Boolean(searchInput()), true)

act(() => searchInput().props.onChange({ target: { value: '#想法' } }))
check('按标签筛出全部带该标签的便签（含归档）', sortedShown(), ['#想法 把便签栏做成可折叠的', '#想法 #待办 周五前给设计稿', '归档的一条 #想法'].sort())
check('标签连同 # 一起高亮', marks().map((el) => el.props.children), ['#想法', '#想法', '#想法'])

// 前缀匹配：打一半就能筛（词表是「边打边筛」，不该要求打完整个标签）
act(() => searchInput().props.onChange({ target: { value: '#想' } }))
check('标签支持前缀匹配', sortedShown().length, 3)

// 大小写不敏感（英文标签常见大小写混写）
act(() => searchInput().props.onChange({ target: { value: '#dep' } }))
check('英文标签大小写不敏感', sortedShown(), ['#Deploy 发布前确认回滚方案'])

// 标签 + 正文关键词 = AND
act(() => searchInput().props.onChange({ target: { value: '#想法 待办' } }))
check('标签和关键词叠加（AND）', sortedShown(), ['#想法 #待办 周五前给设计稿'])

// 只敲一个 `#` 还不构成条件：列表照旧、卡片仍可编辑
act(() => searchInput().props.onChange({ target: { value: '#' } }))
check('只敲 # 不算搜索：列表回到当前视图', cardTexts().length, 5)
check('只敲 # 时卡片仍可编辑', noteViews().length, 0)

// 匹配不到的标签：如实给空状态，而不是把列表清空却不说原因
act(() => searchInput().props.onChange({ target: { value: '#不存在' } }))
check('标签无命中时给空状态', emptyTitle(), '没有匹配的便签')

// 正文里的 `#` 不要求前后有空格：文中出现的 #想法 也能被筛出来（t6 就是这么写的）
act(() => searchInput().props.onChange({ target: { value: '#想法' } }))
check('标签出现在句中也算', sortedShown().indexOf('归档的一条 #想法') !== -1, true)

act(() => searchInput().props.onChange({ target: { value: '' } }))
check('清空标签搜索回到当前视图', cardTexts().length, 5)

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
check('「更多」菜单有五项（备份 / 恢复 / 重排 / 从剪贴板记下 / 语音记一条）', menuItems().length, 5)

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

// ---------------------------------------------------------------- 回顾条
//
// 打开面板时在列表上方浮一条「旧便签」：一行高、点开才展开、`×` 关掉今天不再出现。
// 挑选规则：非归档、非置顶、有正文、至少两小时没动过，且不在这三条最新里。

const REVIEW_KEY = 'dsh-sticky-notes:review'
function reviewBar() {
  return elements.find((el) => {
    const cls = String(el.props.className || '')
    return cls === 'dsn-review' || cls === 'dsn-review is-expanded'
  })
}
function reviewMain() {
  return elements.find((el) => String(el.props.className || '') === 'dsn-review-main')
}
function reviewClose() {
  return elements.find((el) => String(el.props.className || '') === 'dsn-icon-btn dsn-review-close')
}
function reviewShownText() {
  const main = reviewMain()
  if (!main) return null
  const text = main.props.children[1]
  return text && flattenText(text)
}
function localDay(ms) {
  const date = new Date(ms)
  const month = date.getMonth() + 1
  const day = date.getDate()
  return `${date.getFullYear()}-${month < 10 ? '0' + month : month}-${day < 10 ? '0' + day : day}`
}

const reviewSeed = [
  { id: 'rv-fresh1', text: '刚写的一条', color: 'amber', createdAt: now - 60000, updatedAt: now - 60000 },
  { id: 'rv-fresh2', text: '十分钟前写的', color: 'sky', createdAt: now - 10 * 60000, updatedAt: now - 10 * 60000 },
  { id: 'rv-fresh3', text: '半小时前写的', color: 'mint', createdAt: now - 30 * 60000, updatedAt: now - 30 * 60000 },
  { id: 'rv-old', text: '旧的一条（三小时前）', color: 'rose', createdAt: now - 3 * 3600 * 1000, updatedAt: now - 3 * 3600 * 1000 },
  {
    id: 'rv-old2',
    text: '更旧的一条（两天前）',
    color: 'violet',
    createdAt: now - 2 * 24 * 3600 * 1000,
    updatedAt: now - 2 * 24 * 3600 * 1000,
  },
  {
    id: 'rv-pinned',
    text: '置顶的老便签不该被回顾',
    color: 'amber',
    pinned: true,
    order: -10,
    createdAt: now - 5 * 3600 * 1000,
    updatedAt: now - 5 * 3600 * 1000,
  },
  {
    id: 'rv-archived',
    text: '归档的老便签不该被回顾',
    color: 'sky',
    archived: true,
    archivedAt: now - 6 * 3600 * 1000,
    createdAt: now - 6 * 3600 * 1000,
    updatedAt: now - 6 * 3600 * 1000,
  },
]

storage.delete(REVIEW_KEY)
remount(reviewSeed)
check('有旧便签时打开面板出现回顾条', Boolean(reviewBar()), true)
check('回顾条有标签', flattenText(reviewMain().props.children[0]), '翻到一条')
check(
  '回顾条只挑旧的那两条之一',
  ['旧的一条（三小时前）', '更旧的一条（两天前）'].indexOf(reviewShownText()) !== -1,
  true,
)
check('刚写的不参与回顾', reviewShownText() === '刚写的一条' || reviewShownText() === '十分钟前写的', false)
check(
  '置顶 / 归档的不参与回顾',
  reviewShownText() === '置顶的老便签不该被回顾' || reviewShownText() === '归档的老便签不该被回顾',
  false,
)
check(
  '回顾条在列表上方',
  elements.indexOf(reviewBar()) < elements.indexOf(elements.find((el) => String(el.props.className || '').indexOf('dsn-list') === 0)),
  true,
)

// 默认一行高：没有展开态就没有 is-expanded（正文靠 CSS 省略号截断，不抢首屏）
check('回顾条默认不展开', reviewBar().props.className, 'dsn-review')
act(() => reviewMain().props.onClick({}))
check('点一下展开全文', reviewBar().props.className, 'dsn-review is-expanded')
check('展开态写进 aria-expanded', reviewMain().props['aria-expanded'], 'true')
act(() => reviewMain().props.onClick({}))
check('再点一下收起', reviewBar().props.className, 'dsn-review')

// 关闭：今天不再显示
act(() => reviewClose().props.onClick({}))
check('关掉后回顾条消失', Boolean(reviewBar()), false)
check('关闭状态落盘', JSON.parse(storage.get(REVIEW_KEY)).hidden, true)
remount(reviewSeed)
check('同一天再打开也不出现', Boolean(reviewBar()), false)

// 换一天：重新挑一条
storage.set(REVIEW_KEY, JSON.stringify({ day: '2000-01-01', id: '', hidden: false }))
remount(reviewSeed)
check('跨天后重新出现', Boolean(reviewBar()), true)

// 当天已经挑过就不换人：否则打字触发重渲染时会一直换，变成噪音
storage.set(REVIEW_KEY, JSON.stringify({ day: localDay(Date.now()), id: 'rv-old2', hidden: false }))
remount(reviewSeed)
check('当天已挑过就固定那一条', reviewShownText(), '更旧的一条（两天前）')

// 挑中的便签被删了：回顾条自己消失，不留空壳
storage.set(REVIEW_KEY, JSON.stringify({ day: localDay(Date.now()), id: 'rv-deleted', hidden: false }))
remount(reviewSeed)
check('挑中的便签没了就不显示', Boolean(reviewBar()), false)

// 没有旧便签（全是一小时内写的）时不该硬凑一条
storage.delete(REVIEW_KEY)
remount(reviewSeed.slice(0, 3))
check('没有旧便签时不显示', Boolean(reviewBar()), false)

// 搜索时让位：那时列表本身才是焦点
storage.set(REVIEW_KEY, JSON.stringify({ day: localDay(Date.now()), id: 'rv-old', hidden: false }))
remount(reviewSeed)
check('搜索前回顾条在', Boolean(reviewBar()), true)
act(() => searchInput().props.onChange({ target: { value: '旧' } }))
check('搜索时回顾条隐藏', Boolean(reviewBar()), false)
act(() => searchInput().props.onChange({ target: { value: '' } }))
check('清空搜索后回顾条回来', Boolean(reviewBar()), true)

// ---------------------------------------------------------------- 颜色
//
// 色点是「打开调色板」（不再循环换色）：5 个色块都带色名，选色不用试。
// 搜索框左侧的色点按颜色筛，和 `#标签`/关键词是「且」，菜单里带各色条数。

function colorDots() {
  return elements.filter((el) => {
    const cls = String(el.props.className || '')
    return el.type === 'button' && cls.indexOf('dsn-dot-btn') === 0
  })
}
function paletteOptions() {
  return elements.filter((el) => String(el.props.className || '').indexOf('dsn-palette-option') === 0)
}
function colorTrigger() {
  // 只认触发器按钮本身：子元素 .dsn-color-trigger-name 也是同样前缀。
  return elements.find((el) => String(el.props.className || '').split(' ')[0] === 'dsn-color-trigger')
}
function colorMenuItems() {
  return elements.filter((el) => String(el.props.className || '').split(' ')[0] === 'dsn-color-item')
}
function storedNotes() {
  return JSON.parse(storage.get('dsh-sticky-notes:v1')).notes
}
function storedColor(id) {
  const note = storedNotes().find((item) => item.id === id)
  return note && note.color
}
function storedUpdatedAt(id) {
  const note = storedNotes().find((item) => item.id === id)
  return note && note.updatedAt
}

const colorSeed = [
  { id: 'c1', text: '琥珀的工作想法', color: 'amber', createdAt: now - 6000, updatedAt: now - 6000 },
  { id: 'c2', text: '琥珀的另一个想法', color: 'amber', createdAt: now - 5000, updatedAt: now - 5000 },
  { id: 'c3', text: '#想法 天蓝那条', color: 'sky', createdAt: now - 4000, updatedAt: now - 4000 },
  { id: 'c4', text: '#想法 玫瑰那条', color: 'rose', createdAt: now - 3000, updatedAt: now - 3000 },
  { id: 'c5', text: '薄荷的一条', color: 'mint', createdAt: now - 2000, updatedAt: now - 2000 },
  {
    id: 'c6',
    text: '紫罗兰的一条（归档）',
    color: 'violet',
    archived: true,
    archivedAt: now - 1000,
    createdAt: now - 7000,
    updatedAt: now - 7000,
  },
]

remount(colorSeed)
check('非归档便签都有色点，归档的没有', colorDots().length, 5)

// 点色点 → 内联调色板，5 个色块都带色名，当前色被标出来
act(() => colorDots()[0].props.onClick({}))
check('点色点弹出色板', paletteOptions().length, 5)
check(
  '色板按重要程度排出 5 档',
  paletteOptions().map((el) => flattenText(el.props.children[1])),
  ['1 最要紧', '2 要紧', '3 一般', '4 靠后', '5 未排'],
)
check('当前色被标出（只有一个）', paletteOptions().filter((el) => el.props['aria-pressed'] === 'true').length, 1)
check('当前色的名字对得上', paletteOptions().map((el) => el.props['aria-pressed'])[2], 'true')
check('色点带档位数字 + 名称（读屏要知道现在是哪一档）', colorDots()[0].props['aria-label'], '重要程度：3 一般，点击更换')
check('有档位的便签在色点旁显示数字', flattenText(colorDots()[0].props.children), '3')

// 选色：直接落到目标色，不是循环
const beforeUpdated = storedUpdatedAt('c5')
act(() => paletteOptions()[3].props.onClick({}))
advance(300)
check('选色后便签落到目标档', storedColor('c5'), 'sky')
check('选完色板自动收起', paletteOptions().length, 0)
check('换色不改 updatedAt（不该把便签顶到最上面）', storedUpdatedAt('c5'), beforeUpdated)

// Esc 关色板：不选色、也不收面板
act(() => colorDots()[0].props.onClick({}))
check('再次点色点重新打开', paletteOptions().length, 5)
pressKey({ key: 'Escape' })
check('Esc 收起色板', paletteOptions().length, 0)
check('Esc 关色板时面板还在', elements.some((el) => el.props.className === 'dsn-panel'), true)
check('Esc 关色板不改颜色', storedColor('c5'), 'sky')

// 搜索框左侧的颜色筛选：菜单带条数（按当前搜索词算、不叠加颜色条件）
// 上一段改过 c5 的颜色，这里重新挂载回到种子数据。
remount(colorSeed)
check('搜索框里有颜色触发器', Boolean(colorTrigger()), true)
act(() => colorTrigger().props.onClick({}))
check('颜色菜单里是「全部 + 5 色」', colorMenuItems().length, 6)
check('「全部颜色」的条数', flattenText(colorMenuItems()[0].props.children[2]), '6')
check('各档条数按重要程度分组', colorMenuItems().slice(1).map((el) => flattenText(el.props.children[2])), ['1', '2', '1', '1', '1'])

// 选一个颜色 → 列表只剩这一色，视图芯片同步高亮「全部」
act(() => colorMenuItems()[2].props.onClick({}))
check('按档位筛出「2 要紧」的两条', shownTexts().slice().sort(), ['琥珀的另一个想法', '琥珀的工作想法'].sort())
check('颜色筛选时「全部」标签高亮', filterTabs()[0].props['aria-selected'], 'true')
check('颜色触发器带上档位', flattenText(colorTrigger().props.children[1]), '2 要紧')

// 和 `#标签` 是「且」：琥珀 + `#想法` → 没有交集（不是把两批并起来）
act(() => searchInput().props.onChange({ target: { value: '#想法' } }))
check('颜色与标签是「且」，交集为空', shownTexts(), [])

// 清掉颜色后只剩标签命中的两条；此时各色条数只算搜索命中的那些
act(() => colorTrigger().props.onClick({}))
act(() => colorMenuItems()[0].props.onClick({}))
check('清掉颜色后按标签筛出两条', shownTexts().slice().sort(), ['#想法 天蓝那条', '#想法 玫瑰那条'].sort())
act(() => colorTrigger().props.onClick({}))
check(
  '有搜索词时各档条数只算命中项',
  colorMenuItems().slice(1).map((el) => flattenText(el.props.children[2])),
  ['1', '0', '0', '1', '0'],
)
act(() => colorMenuItems()[1].props.onClick({}))
check('再按颜色收窄到一条', shownTexts(), ['#想法 玫瑰那条'])

// 输入法组词中按 Esc 是「取消候选」，不能当成退出面板 / 清搜索词
function searchValue() {
  const input = searchInput()
  return input ? input.props.value : null
}
pressKey({ key: 'Escape', isComposing: true })
check('组词中 Esc 不收起面板', elements.some((el) => el.props.className === 'dsn-panel'), true)
check('组词中 Esc 不清搜索词', searchValue(), '#想法')
pressKey({ key: 'Escape', isComposing: false, keyCode: 229 })
check('Safari 式 keyCode 229 的 Esc 也不清搜索词', searchValue(), '#想法')

// Esc 逐层退出：先清搜索词，再清颜色筛选，最后才收面板（与 Esc 链的顺序一致）
pressKey({ key: 'Escape' })
check('Esc 先清搜索词', searchValue(), '')
check('清掉搜索后颜色筛选仍生效', shownTexts(), ['#想法 玫瑰那条'])
pressKey({ key: 'Escape' })
check('Esc 再清颜色筛选', shownTexts().length, 5)
pressKey({ key: 'Escape' })
check('Esc 最后才收面板', elements.some((el) => el.props.className === 'dsn-panel'), false)

// 没有搜索词时，组词中 Esc 会不会把面板整个收掉（这是更常见的中文输入场景）
pressKey({ altKey: true, shiftKey: true, key: 'N' })
check('重新展开面板（Esc 用例收尾）', elements.some((el) => el.props.className === 'dsn-panel'), true)
pressKey({ key: 'Escape', isComposing: true })
check('组词中 Esc 不收起面板（无搜索词时）', elements.some((el) => el.props.className === 'dsn-panel'), true)

// 切视图芯片会清掉颜色筛选（否则点「已归档」看起来没反应）
remount(colorSeed)
act(() => colorTrigger().props.onClick({}))
act(() => colorMenuItems()[4].props.onClick({}))
check('切视图前颜色筛选生效', cardTexts(), ['#想法 天蓝那条'])
act(() => filterTabs()[1].props.onClick({}))
check('切到已归档视图后颜色筛选被清掉', String(colorTrigger().props.className).indexOf('is-active') === -1, true)
check('已归档视图显示归档便签', cardTexts(), ['紫罗兰的一条（归档）'])

// 默认档：新便签不再随机取色，统一落到「未排」（5），系统不替你排优先级
storage.delete('dsh-sticky-notes:draft')
remount([])
act(() => draftArea().props.onChange({ target: { value: '第一条随手记' } }))
act(() => draftArea().props.onKeyDown({ nativeEvent: { isComposing: false }, ctrlKey: true, key: 'Enter', preventDefault() {} }))
act(() => draftArea().props.onChange({ target: { value: '第二条随手记' } }))
act(() => draftArea().props.onKeyDown({ nativeEvent: { isComposing: false }, ctrlKey: true, key: 'Enter', preventDefault() {} }))
advance(300)
const freshNotes = JSON.parse(storage.get('dsh-sticky-notes:v1')).notes
check('新便签默认落在「未排」这一档', freshNotes.map((note) => note.color), ['violet', 'violet'])
check('「未排」的色点旁不显示数字（不假装有优先级）', flattenText(colorDots()[0].props.children), '')

// 换色埋点：P0 要求先能量到「有没有人真的用颜色」
storage.delete('dsh-sticky-notes:metrics:v1')
act(() => colorDots()[0].props.onClick({}))
act(() => paletteOptions()[0].props.onClick({}))
advance(300)
const metricsRaw = storage.get('dsh-sticky-notes:metrics:v1')
check('换色会计一次数', metricsRaw ? JSON.parse(metricsRaw).counters.color : 0, 1)

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

// ---------------------------------------------------------------- 剪贴板捕获
//
// 两条入口、两种行为：面板内空白处 Ctrl+V 直接成便签（5 秒撤销）；
// 「更多」菜单里只填进草稿（先看后交，敏感内容不会因一次误点落盘）。

function panelEl() {
  return elements.find((el) => el.type === 'aside' && el.props.className === 'dsn-panel')
}
function metricsNow() {
  const raw = storage.get('dsh-sticky-notes:metrics:v1')
  return raw ? JSON.parse(raw).counters : {}
}

storage.delete('dsh-sticky-notes:metrics:v1')
storage.delete('dsh-sticky-notes:draft')
remount([{ id: 'c1', text: '已经在这条', color: 'amber', pinned: false, createdAt: now - 1000, updatedAt: now - 1000 }])
check('剪贴板组初始只有一条', cardTexts(), ['已经在这条'])

// 1. 快捷档：焦点在面板空白处，Ctrl+V 直接成一条（清洗首尾空白、保留内部换行）
clipboardText = '  从聊天框复制的一段结论\r\n第二行  '
const pasted = dispatchPaste({ target: panelEl(), text: clipboardText })
check('空白处粘贴被接管（原生粘贴被拦）', pasted.defaultPrevented, true)
check('粘贴直接多出一条便签', cardTexts().length, 2)
check('内容清洗：去首尾空白、CRLF 归一、内部换行保留', cardTexts()[0], '从聊天框复制的一段结论\n第二行')
check('提示带前 30 字预览', toastEl() && toastEl().props.children[0].props.children, '已从剪贴板记下 · 从聊天框复制的一段结论 第二行')
check('剪贴板捕获计数 +1', metricsNow().clipboard, 1)
check('短便签计入长度桶', metricsNow().lenShort, 1)

// 2. 5 秒内可撤销：和删除走同一条通道
act(() => toastUndo().props.onClick({}))
check('撤销后回到一条', cardTexts(), ['已经在这条'])

// 3. 焦点在输入框里时绝不能接管：Ctrl+V 必须是原生粘贴
const nativePaste = dispatchPaste({ target: draftArea(), text: '粘进草稿的' })
check('输入框内粘贴不被接管', nativePaste.defaultPrevented, false)
check('输入框内粘贴不新增便签', cardTexts().length, 1)

// 4. 重复内容：不新增，提示「已经在列表里」
const dupPaste = dispatchPaste({ target: panelEl(), text: '已经在这条' })
check('重复内容仍然接管（不交给原生粘贴）', dupPaste.defaultPrevented, true)
check('重复内容不新增', cardTexts().length, 1)
check('重复内容给提示', toastEl() && toastEl().props.children[0].props.children, '这条已经在列表里')

// 5. 超长（>8000）直接拒绝；2000-8000 退到草稿
dispatchPaste({ target: panelEl(), text: 'x'.repeat(9000) })
check('超长内容被拒绝', cardTexts().length, 1)
check('超长内容说清楚原因', toastEl() && toastEl().props.children[0].props.children, '内容太长，便签不是剪藏（上限 8000 字）')
const longText = 'y'.repeat(2500)
dispatchPaste({ target: panelEl(), text: longText })
check('2000-8000 字退到草稿而不是成卡', cardTexts().length, 1)
check('长内容确实进了草稿', draftArea().props.value, longText)
check('长内容提示进草稿', toastEl() && toastEl().props.children[0].props.children, '内容有点长，已放进草稿')

// 6. 菜单档：读剪贴板 → 只填草稿，不建卡
clipboardText = '剪贴板里的第二段'
act(() => menuButton().props.onClick({}))
check('菜单最后一项是从剪贴板记下', flattenText(menuItems()[3].props.children), '从剪贴板记下（先进草稿）')
await actAsync(() => menuItems()[3].props.onClick({}))
check('菜单档只填草稿', draftArea().props.value, '剪贴板里的第二段')
check('菜单档不建卡', cardTexts().length, 1)
check('菜单档提示先看再记', toastEl() && toastEl().props.children[0].props.children, '已放入草稿，看一眼再记下')

// 7. 草稿里按 Ctrl+Enter 才算记下（先看后交的意义）
act(() => draftArea().props.onKeyDown({ nativeEvent: { isComposing: false }, ctrlKey: true, key: 'Enter', preventDefault() {} }))
check('确认后草稿变成一条便签', cardTexts()[0], '剪贴板里的第二段')
check('确认后草稿清空', draftArea().props.value, '')

// 8. 读不到剪贴板：诚实报错 + 给手动粘贴的退路
clipboardFail = true
act(() => menuButton().props.onClick({}))
await actAsync(() => menuItems()[3].props.onClick({}))
check(
  '读不到剪贴板时给退路提示',
  toastEl() && toastEl().props.children[0].props.children,
  '这个环境读不到剪贴板，可以点输入框按 Ctrl+V',
)
clipboardFail = false

// 9. 空剪贴板：明确说「没有文字」，别表现为按钮坏了
clipboardText = '   '
act(() => menuButton().props.onClick({}))
await actAsync(() => menuItems()[3].props.onClick({}))
check('空剪贴板给明确提示', toastEl() && toastEl().props.children[0].props.children, '剪贴板里没有文字')

// 10. 内容保真：ZWJ / ZWNJ 是「语义连接符」，不是零宽垃圾。
//     删 ZWJ 会把 👨‍👩‍👧 拆成三个独立 emoji；删 ZWNJ 会把波斯语单词改成另一个词。
const family = '👨\u200d👩\u200d👧'
const persian = 'می\u200cخواهم'
clipboardText = '家人 ' + family + ' 和 ' + persian
dispatchPaste({ target: panelEl(), text: clipboardText })
check('组合 emoji 保持完整（ZWJ 没被删）', cardTexts()[0], clipboardText)
check('波斯语 ZWNJ 没被删', cardTexts()[0].indexOf('\u200c') !== -1, true)

// 真正的零宽垃圾（ZWSP / BOM）仍然清掉
clipboardText = '\u200b\u200b带零宽空格的句子\ufeff'
dispatchPaste({ target: panelEl(), text: clipboardText })
check('零宽空格 / BOM 仍然清掉', cardTexts()[0], '带零宽空格的句子')

// ---------------------------------------------------------------- 多标签页同步
//
// 另一个标签页写入时会派发 window 的 storage 事件。本页可能正打着字（300ms 去抖还没落盘），
// 此时整份替换会把这页的字冲掉，所以必须按 id 合并：保本页改动、收别处新增、跟别处删除，
// 但本页刚删掉的不被别处复活。

const multiSeed = [
  { id: 'mt1', text: '本页正在写的', color: 'amber', pinned: false, createdAt: now - 2000, updatedAt: now - 2000 },
  { id: 'mt2', text: '别处会改的', color: 'sky', pinned: false, createdAt: now - 3000, updatedAt: now - 3000 },
]
remount(multiSeed)
act(() => cards()[0].props.onChange({ target: { value: '本页正在写的（打到一半）' } }))

// 另一个标签页：改了 mt2、加了 mt3，然后落盘并派发 storage（它没见过本页刚打的字）
const remoteSnapshot = [
  { id: 'mt1', text: '本页正在写的', color: 'amber', pinned: false, createdAt: now - 2000, updatedAt: now - 2000 },
  { id: 'mt2', text: '别处改过的', color: 'sky', pinned: false, createdAt: now - 3000, updatedAt: now - 100 },
  { id: 'mt3', text: '别处新增的', color: 'mint', pinned: false, createdAt: now - 50, updatedAt: now - 50 },
]
writeStorageNotes(remoteSnapshot)
dispatchStorage()
check('多标签页：本页未落盘的编辑还在', cardTexts().indexOf('本页正在写的（打到一半）') !== -1, true)
check('多标签页：别处新增的便签收进来', cardTexts().indexOf('别处新增的') !== -1, true)
check('多标签页：本页没动的便签跟着别处更新', cardTexts().indexOf('别处改过的') !== -1, true)

advance(300)
const syncedNotes = JSON.parse(storage.get('dsh-sticky-notes:v1')).notes
check('合并结果落盘（本页编辑 + 别处新增都在）', syncedNotes.map((note) => note.text).sort(), ['本页正在写的（打到一半）', '别处改过的', '别处新增的'].sort())

// 本页刚删掉一条（还没落盘），别页快照里还有它：不能被复活
const deletedIndex = cardTexts().indexOf('别处改过的')
act(() => noteButtons('dsn-icon-btn dsn-del')[deletedIndex].props.onClick())
check('删除立即生效', cardTexts().indexOf('别处改过的'), -1)
writeStorageNotes(remoteSnapshot)
dispatchStorage()
check('多标签页：本页刚删掉的便签不被别页复活', cardTexts().indexOf('别处改过的'), -1)
advance(300)
check('删除也落盘了', JSON.parse(storage.get('dsh-sticky-notes:v1')).notes.some((note) => note.id === 'mt2'), false)

// 本页没有未落盘改动时，仍然直接采用别页版本（别页的新增/修改不会被挡住）
remount(multiSeed)
advance(300)
writeStorageNotes([{ id: 'mt9', text: '另一页新增的', color: 'rose', pinned: false, createdAt: now, updatedAt: now }])
dispatchStorage()
check('本页干净时直接采用别页版本', cardTexts(), ['另一页新增的'])

// ---------------------------------------------------------------- 渲染优化：tick 不进卡片 props
//
// 以前 tick 作为卡片 prop：每 30 秒心跳、以及每次「记下」都会让所有卡片的 memo 失效。
// 现在父组件把相对时间算成字符串传下去：文案没变的卡片不重画。

const tickSeed = [
  { id: 'p1', text: '三小时前写的', color: 'amber', pinned: false, createdAt: now - 3 * 3600 * 1000 - 5000, updatedAt: now - 3 * 3600 * 1000 - 5000 },
  { id: 'p2', text: '五小时前写的', color: 'sky', pinned: false, createdAt: now - 5 * 3600 * 1000, updatedAt: now - 5 * 3600 * 1000 },
]
remount(tickSeed)
// 模拟「面板开了一会儿再记下」：让 tick 和此刻真的差 2 秒（旧代码会在这里 setTick(now)，
// 于是所有卡片的 tick prop 都变、memo 全失效；新代码不该再触发列表重画）。
advance(2000)
act(() => draftArea().props.onChange({ target: { value: '再记一条' } }))
act(() => draftArea().props.onKeyDown({ nativeEvent: { isComposing: false }, ctrlKey: true, key: 'Enter', preventDefault() {} }))
check('记下一条只重渲染新卡片（其余 memo 命中）', maxPassCardRenders, 1)
maxPassCardRenders = 0
advance(30000)
check('30 秒心跳不会让时间文案没变的卡片重渲染', maxPassCardRenders, 0)

// ---------------------------------------------------------------- 语音输入（2a）
//
// 真麦克风/真模型不参与单测：假 getUserMedia / MediaRecorder / AudioContext / fetch，
// 验证「入口 → 录音 → 停止 → 转写 → 进草稿且不提交」与各失败态。

const READY_VOICE_CATALOG = voiceCatalogPayload
function voiceRow() {
  return elements.find((el) => el.props.className === 'dsn-voice')
}
function voiceStopButton() {
  return elements.find((el) => el.props.className === 'dsn-voice-btn')
}
function voiceMicButton() {
  return elements.find((el) => el.props.className && String(el.props.className).indexOf('dsn-voice-mic') !== -1)
}
function voiceFetchTargets() {
  return voiceFetchCalls.map((call) => call.url)
}
async function settleVoice() {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setImmediate(resolve))
    flush()
  }
}

const voiceSeed = [
  { id: 'v1', text: '已有的一条', color: 'amber', pinned: false, createdAt: now - 1000, updatedAt: now - 1000 },
]
remount(voiceSeed)
await settleVoice()
check('打开面板会读一次语音 catalog', voiceFetchTargets().some((url) => url.indexOf('/voice/catalog') !== -1), true)
check('没用过语音时草稿框没有麦克风', Boolean(voiceMicButton()), false)

// 入口：⋯ 菜单最后一项，catalog 可用时不禁用
act(() => menuButton().props.onClick({}))
check('「更多」菜单多了语音入口（5 项）', menuItems().length, 5)
const voiceEntry = menuItems()[4]
check('语音入口文案', flattenText(voiceEntry && voiceEntry.props.children), '语音记一条')
check('catalog 可用时语音入口可用', Boolean(voiceEntry && voiceEntry.props.disabled), false)

// 录音 → 停止 → 转写 → 文本进草稿，且不自动提交
const notesBeforeVoice = cards().length
micStreamStopped = 0
act(() => {
  if (voiceEntry) voiceEntry.props.onClick()
})
await settleVoice()
check('进入录音态出现状态行', Boolean(voiceRow()), true)
check('录音状态行写「录音中」', flattenText(voiceRow()).indexOf('录音中') !== -1, true)
act(() => {
  if (voiceStopButton()) voiceStopButton().props.onClick()
})
check('停止后进入转写态', flattenText(voiceRow()).indexOf('转写中') !== -1, true)
await settleVoice()
check('识别文本进入草稿', draftArea().props.value, '语音识别出的文本')
check('语音不自动提交（条数不变）', cards().length, notesBeforeVoice)
check('转写完成后状态行消失', Boolean(voiceRow()), false)
check('用过一次后草稿框出现麦克风', Boolean(voiceMicButton()), true)
check('语音计数 +1', (() => {
  const raw = storage.get('dsh-sticky-notes:metrics:v1')
  return raw ? JSON.parse(raw).counters.voice : 0
})(), 1)
const transcribeCall = voiceFetchCalls.filter((call) => call.url.indexOf('/voice/transcribe') !== -1).pop()
const sentBase64 = transcribeCall && JSON.parse(transcribeCall.init.body).audioBase64
check('发给 host 的是 WAV（RIFF 头）', Boolean(sentBase64) && Buffer.from(sentBase64, 'base64').toString('ascii', 0, 4) === 'RIFF', true)

// 麦克风权限被拒绝：给一句人话，不进录音态
micError = { name: 'NotAllowedError' }
remount(voiceSeed)
await settleVoice()
act(() => menuButton().props.onClick({}))
act(() => {
  const entry = menuItems()[4]
  if (entry) entry.props.onClick()
})
await settleVoice()
check('权限拒绝给出说明', toastEl() && toastEl().props.children[0].props.children, '没有麦克风权限，请在系统/浏览器里允许后重试')
check('权限拒绝后没有录音行', Boolean(voiceRow()), false)
micError = null

// provider 被设成云端：入口禁用 + title 说明，不偷偷发音频
voiceCatalogPayload = {
  ok: true,
  catalog: { available: false, reason: 'not-local', providerId: 'cloud', location: 'cloud', preparation: 'ready', language: 'auto', limits: { maxDurationSeconds: 60, maxAudioBytes: 2 * 1024 * 1024 } },
}
remount(voiceSeed)
await settleVoice()
act(() => menuButton().props.onClick({}))
const gatedEntry = menuItems()[4]
check('云端 provider 时语音入口禁用', Boolean(gatedEntry && gatedEntry.props.disabled), true)
check('禁用原因写进 title', String(gatedEntry && gatedEntry.props.title).indexOf('云端') !== -1, true)
voiceCatalogPayload = READY_VOICE_CATALOG

// Esc 取消录音：释放麦克风，不发转写请求
remount(voiceSeed)
await settleVoice()
act(() => menuButton().props.onClick({}))
act(() => {
  const entry = menuItems()[4]
  if (entry) entry.props.onClick()
})
await settleVoice()
check('录音中状态行在', Boolean(voiceRow()), true)
micStreamStopped = 0
const transcribeBeforeCancel = voiceFetchTargets().filter((url) => url.indexOf('/voice/transcribe') !== -1).length
pressKey({ key: 'Escape' })
check('Esc 取消录音后状态行消失', Boolean(voiceRow()), false)
check('Esc 取消时释放麦克风', micStreamStopped > 0, true)
check('Esc 取消后不发转写请求', voiceFetchTargets().filter((url) => url.indexOf('/voice/transcribe') !== -1).length, transcribeBeforeCancel)

// ---------------------------------------------------------------- 语音搜索（2b）
//
// 拍板：转写直接填搜索框并立即筛。搜索框只在便签 ≥ 6 条时出现，麦克风跟着它一起出现。

const voiceSearchSeed = [
  { id: 'vs1', text: '语音筛出来的想法', color: 'amber', pinned: false, createdAt: now - 6000, updatedAt: now - 6000 },
  { id: 'vs2', text: '买咖啡豆', color: 'sky', pinned: false, createdAt: now - 5000, updatedAt: now - 5000 },
  { id: 'vs3', text: '周五复盘提纲', color: 'mint', pinned: false, createdAt: now - 4000, updatedAt: now - 4000 },
  { id: 'vs4', text: '给妈妈打电话', color: 'rose', pinned: false, createdAt: now - 3000, updatedAt: now - 3000 },
  { id: 'vs5', text: '读《卡片笔记法》', color: 'violet', pinned: false, createdAt: now - 2000, updatedAt: now - 2000 },
  { id: 'vs6', text: '周三前交稿', color: 'amber', pinned: false, createdAt: now - 1000, updatedAt: now - 1000 },
]

function voiceSearchButton() {
  return elements.find((el) => el.props.className && String(el.props.className).indexOf('dsn-search-voice') !== -1)
}

const previousVoiceTranscribe = voiceTranscribePayload
voiceTranscribePayload = { ok: true, text: '语音筛出来的想法', audioSeconds: 1, inferenceSeconds: 0.05 }
storage.delete('dsh-sticky-notes:draft')
remount(voiceSearchSeed)
await settleVoice()
check('便签够多时搜索框带语音搜索按钮', Boolean(voiceSearchButton()), true)

act(() => {
  if (voiceSearchButton()) voiceSearchButton().props.onClick()
})
await settleVoice()
check('语音搜索进入录音态', Boolean(voiceRow()), true)
act(() => {
  if (voiceStopButton()) voiceStopButton().props.onClick()
})
await settleVoice()
check('语音搜索把转写填进搜索框', searchInput().props.value, '语音筛出来的想法')
check('语音搜索立即筛出结果', shownTexts(), ['语音筛出来的想法'])
check('语音搜索不往草稿里写', draftArea().props.value, '')

// Esc 取消语音搜索：不留状态
remount(voiceSearchSeed)
await settleVoice()
act(() => {
  if (voiceSearchButton()) voiceSearchButton().props.onClick()
})
await settleVoice()
pressKey({ key: 'Escape' })
check('Esc 取消语音搜索后状态行消失', Boolean(voiceRow()), false)
check('取消后搜索框仍为空', searchInput() ? searchInput().props.value : null, '')

// catalog 不可用时语音搜索禁用（和语音输入同一道闸门）
voiceCatalogPayload = {
  ok: true,
  catalog: { available: false, reason: 'no-service', providerId: '', location: '', preparation: '', language: 'auto', limits: { maxDurationSeconds: 60, maxAudioBytes: 2 * 1024 * 1024 } },
}
remount(voiceSearchSeed)
await settleVoice()
check('catalog 不可用时语音搜索禁用', Boolean(voiceSearchButton() && voiceSearchButton().props.disabled), true)
voiceCatalogPayload = READY_VOICE_CATALOG
voiceTranscribePayload = previousVoiceTranscribe

// ---------------------------------------------------------------- 语音完善（真机反馈）
//
// ① 旧 Host 只把 ready 算 available，standby 被误判成未就绪 → 客户端兜住；
// ② 手动点停止不方便 → 说完静音 1.8s 自动停 + 电平条 + 剩余秒数；
// ③ 语音搜索入口太深 → 头部常驻麦克风；
// ④ 失败后给「重试」，不用重新找入口。

// ① standby 兼容
voiceCatalogPayload = {
  ok: true,
  catalog: {
    available: false,
    reason: 'not-ready',
    providerId: 'sensevoice-local',
    location: 'host-local',
    preparation: 'standby',
    language: 'auto',
    limits: { maxDurationSeconds: 60, maxAudioBytes: 2 * 1024 * 1024 },
  },
}
remount(voiceSeed)
await settleVoice()
act(() => menuButton().props.onClick({}))
const standbyEntry = menuItems()[4]
check('standby 不会把语音入口禁用（客户端兼容旧 Host）', Boolean(standbyEntry && standbyEntry.props.disabled), false)
pressKey({ key: 'Escape' })
voiceCatalogPayload = READY_VOICE_CATALOG

// ② 电平 + 剩余秒数 + 静音自动停
storage.delete('dsh-sticky-notes:draft')
voiceTranscribePayload = { ok: true, text: '自动停下来的结果', audioSeconds: 1, inferenceSeconds: 0.05 }
remount(voiceSeed)
await settleVoice()
act(() => menuButton().props.onClick({}))
act(() => menuItems()[4].props.onClick())
await settleVoice()
fakeVoiceLevel = 0.4
advance(400)
check('录音行显示剩余秒数', String(flattenText(voiceRow())).indexOf('剩余') !== -1, true)
const levelFill = elements.find((el) => el.props.className === 'dsn-voice-level-fill')
check('录音行有电平条且随音量变化', Boolean(levelFill) && String(levelFill.props.style.width) === '40%', true)
fakeVoiceLevel = 0
advance(2500)
await settleVoice()
check('说完静音 1.8 秒自动停止并转写', draftArea().props.value, '自动停下来的结果')

// ③ 头部语音搜索入口 + 去尾部标点
storage.delete('dsh-sticky-notes:draft')
voiceTranscribePayload = { ok: true, text: '已有。', audioSeconds: 1, inferenceSeconds: 0.05 }
remount(voiceSeed)
await settleVoice()
const headVoice = elements.find((el) => String(el.props.className || '').indexOf('dsn-head-voice') !== -1)
check('便签很少时头部也有语音搜索按钮', Boolean(headVoice), true)
check('默认没有搜索框', Boolean(searchInput()), false)
act(() => {
  if (headVoice) headVoice.props.onClick()
})
await settleVoice()
check('语音搜索时临时出现搜索框', Boolean(searchInput()), true)
act(() => {
  if (voiceStopButton()) voiceStopButton().props.onClick()
})
await settleVoice()
check('头部语音搜索直接筛（去掉尾部标点）', searchInput() ? searchInput().props.value : null, '已有')
check('搜索命中已有便签', shownTexts(), ['已有的一条'])

// ④ 失败后重试
micError = { name: 'NotAllowedError' }
storage.delete('dsh-sticky-notes:draft')
remount(voiceSeed)
await settleVoice()
act(() => menuButton().props.onClick({}))
act(() => menuItems()[4].props.onClick())
await settleVoice()
const retryBtn = elements.find(
  (el) => el.type === 'button' && el.props.className === 'dsn-toast-undo' && String(flattenText(el.props.children)).indexOf('重试') !== -1,
)
check('失败提示带「重试」按钮', Boolean(retryBtn), true)
micError = null
act(() => {
  if (retryBtn) retryBtn.props.onClick()
})
await settleVoice()
check('点重试后重新进入录音态', Boolean(voiceRow()), true)
pressKey({ key: 'Escape' })
voiceTranscribePayload = previousVoiceTranscribe

// ⑤ 面板初始收起：open 相关 effect 的依赖必须跟得上（修 0.1.24 一直灰的根因）
//
// 真机上「页面加载时面板是收起」是常见路径：catalog effect 若拿不到 open 的新值，
// 就只在挂载时跑一次（open=false 直接返回），之后打开面板也不会请求 catalog。
storage.delete('dsh-sticky-notes:draft')
const catalogCallsBeforeClosedMount = voiceFetchTargets().filter((url) => url.indexOf('/voice/catalog') !== -1).length
remount(voiceSeed, {}, '0')
await settleVoice()
check('面板收起时不请求 catalog', voiceFetchTargets().filter((url) => url.indexOf('/voice/catalog') !== -1).length, catalogCallsBeforeClosedMount)
check('收起时没有面板', elements.some((el) => el.props.className === 'dsn-panel'), false)
act(() => {
  const tab = tabButton()
  if (tab) tab.props.onClick({})
})
await settleVoice()
check(
  '从收起打开后请求一次 catalog',
  voiceFetchTargets().filter((url) => url.indexOf('/voice/catalog') !== -1).length,
  catalogCallsBeforeClosedMount + 1,
)
const headAfterOpen = elements.find((el) => String(el.props.className || '').indexOf('dsn-head-voice') !== -1)
check('从收起打开后头部麦克风可用', Boolean(headAfterOpen && headAfterOpen.props.disabled), false)
// 同一个根因还影响编辑焦点跟踪：打开后点正文应能进入编辑态（Esc 取消编辑）。
focusinNote('v1')
check('从收起打开后点正文进入编辑态', Boolean(editHint()), true)
pressKey({ key: 'Escape' })
check('取消编辑后面板还在', elements.some((el) => el.props.className === 'dsn-panel'), true)
act(() => menuButton().props.onClick({}))
const entryAfterOpen = menuItems()[4]
check('从收起打开后语音入口可用', Boolean(entryAfterOpen && entryAfterOpen.props.disabled), false)
pressKey({ key: 'Escape' })

// ⑥ 语音搜索成功的提示不该再叫用户按 Ctrl+Enter
voiceTranscribePayload = { ok: true, text: '语音筛出来的想法', audioSeconds: 1, inferenceSeconds: 0.05 }
storage.delete('dsh-sticky-notes:draft')
remount(voiceSearchSeed)
await settleVoice()
act(() => {
  if (voiceSearchButton()) voiceSearchButton().props.onClick()
})
await settleVoice()
act(() => {
  if (voiceStopButton()) voiceStopButton().props.onClick()
})
await settleVoice()
check('语音搜索成功提示是「已按语音筛选」', flattenText(toastEl()), '已按语音筛选')
check('语音搜索提示不出现 Ctrl+Enter', String(flattenText(toastEl())).indexOf('Ctrl+Enter'), -1)

// ⑦ 语音记一条时不应平白冒出搜索框（只有语音搜索才临时显示）
remount(voiceSeed)
await settleVoice()
act(() => menuButton().props.onClick({}))
act(() => menuItems()[4].props.onClick())
await settleVoice()
check('语音记一条时没有搜索框', Boolean(searchInput()), false)
pressKey({ key: 'Escape' })

// ⑧ 转写中显示已用时（本机模型 standby 冷启动时用户不干等）
storage.delete('dsh-sticky-notes:draft')
voiceTranscribePayload = { ok: true, text: '冷启动后的结果', audioSeconds: 1, inferenceSeconds: 0.05 }
let releaseTranscribe = null
voiceTranscribeDelay = new Promise((resolve) => {
  releaseTranscribe = resolve
})
remount(voiceSeed)
await settleVoice()
act(() => menuButton().props.onClick({}))
act(() => menuItems()[4].props.onClick())
await settleVoice()
act(() => {
  if (voiceStopButton()) voiceStopButton().props.onClick()
})
await settleVoice()
advance(2100)
check('转写中显示已用时', String(flattenText(voiceRow())).indexOf('已用时') !== -1, true)
releaseTranscribe()
voiceTranscribeDelay = null
await settleVoice()
check('转写完成后草稿拿到文本', draftArea().props.value, '冷启动后的结果')
voiceTranscribePayload = previousVoiceTranscribe

// ---------------------------------------------------------------- 结果

if (failures.length > 0) {
  console.error('FAIL')
  for (const failure of failures) console.error(' - ' + failure)
  process.exit(1)
}
console.log(
  'PASS  行为测试：编辑不重排 / 失焦只更新时间 / 组词不误存 / 落盘失败如实提示 / 重新编辑（铅笔入口 + 编辑中提示 / Esc 取消恢复原文 / Esc 分层 / 长文本编辑态 60vh / 失焦保存）/ 搜索跨视图 + 命中高亮 / 标签搜索（前缀 + AND）/ 颜色（默认未排 / 具名档位 + 数字通道 / 换色埋点 / 按档筛 + AND）/ 回顾条（挑选 / 展开 / 当天关闭）/ 收起还焦点 / 唤起即聚焦 / 收起态角标（草稿 + 置顶）/ 备份 round-trip / 合并撤销 / 会话绑定 / 来源会话跳转 / 草稿不丢 / 一键复制 / 拖动排序 + 键盘移动 / 剪贴板捕获（快捷档成卡 + 撤销 / 输入框不接管 / 重复不新增 / 超长拒绝 / 长内容进草稿 / 菜单档只填草稿 / 读不到与空剪贴板各有提示 / ZWJ + ZWNJ 不被清洗）/ 多标签页同步（未落盘编辑保留 / 别处新增与修改收进来 / 本页删除不复活 / 本页干净时整份采用）/ 渲染优化（记下一条只重画新卡 / 30 秒心跳不重画未变卡片）/ 输入法 Esc 放行（组词中不清搜索词 / 不收面板）/ 语音输入（入口 / 录音 → 停止 → 转写进草稿且不提交 / WAV 上送 / 权限拒绝 / 云端 provider 禁用 / Esc 取消释放麦克风）/ 语音搜索（搜索框麦克风 / 转写填 query 并立即筛 / 不写草稿 / Esc 取消 / catalog 不可用禁用）/ 语音完善（standby 兼容 / 电平与剩余秒数 / 静音自动停 / 头部语音搜索入口 / 失败重试）/ 语音入口回归（面板初始收起也能请求 catalog / 编辑焦点恢复）/ 语音提示（搜索成功文案 / 记一条不弹搜索框 / 转写中显示已用时）',
)
