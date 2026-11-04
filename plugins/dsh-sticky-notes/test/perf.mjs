// 性能基准：先量再改。
//
// 用假 React 把真实组件渲染 N 次（不涉及状态迁移），量两件事：
//   1. 一次「整树渲染」要构造多少个元素（每次按键现在都会触发一次整树渲染）
//   2. 一次整树渲染耗时（Node 里量，只用于改前/改后对比，不代表浏览器绝对值）
//
// 注意：假 React 里 React.memo 是有语义的（浅比较 props，相等就复用上次结果），
// 否则「加 memo 之后到底省了多少」量不出来。
import fs from 'node:fs'
import vm from 'node:vm'

const CLIENT = process.argv[4]
  ? new URL('file:///' + String(process.argv[4]).replace(/\\/g, '/'))
  : new URL('../lib/client.js', import.meta.url)
const source = fs.readFileSync(CLIENT, 'utf8')

const SIZE = Number(process.argv[2] || 300)
const ROUNDS = Number(process.argv[3] || 60)

// ---------------------------------------------------------------- 造数据

const now = Date.now()
const notes = []
for (let i = 1; i <= SIZE; i += 1) {
  notes.push({
    id: 'n' + i,
    text: '第 ' + i + ' 条便签：随手记下的一句话，长度和日常差不多。',
    color: ['amber', 'sky', 'mint', 'rose', 'violet'][i % 5],
    pinned: i <= 3,
    createdAt: now - i * 60000,
    updatedAt: now - i * 60000,
  })
}

const storage = new Map([
  ['dsh-sticky-notes:v1', JSON.stringify({ notes })],
  ['dsh-sticky-notes:open', '1'],
])

// ---------------------------------------------------------------- 假 React

let elementCount = 0
let cardCount = 0

function createElement(type, rawProps, ...children) {
  const props = Object.assign({}, rawProps || {})
  if (children.length === 1) props.children = children[0]
  else if (children.length > 1) props.children = children
  if (typeof type === 'function') {
    if (type.prototype && typeof type.prototype.render === 'function') return new type(props).render()
    return type(props)
  }
  elementCount += 1
  if (typeof props.className === 'string' && props.className.indexOf('dsn-note dsn-c-') === 0) cardCount += 1
  return { type, props }
}

const hole = { current: null }
let memoCache = new WeakMap()

// hooks 也要有真语义：useMemo/useCallback 按依赖数组缓存，useRef 按槽位稳定，
// 否则量出来的「加了 memo 之后」跟没加一样（引用每次都变，浅比较永远不相等）。
let cursor = 0
let hookSlots = []

function sameDeps(a, b) {
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (!Object.is(a[i], b[i])) return false
  return true
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
    if (!(index in hookSlots)) hookSlots[index] = { value: typeof initial === 'function' ? initial() : initial }
    return [hookSlots[index].value, () => {}]
  },
  useEffect() {
    cursor += 1
  },
  useRef(initial) {
    const index = cursor++
    if (!(index in hookSlots)) hookSlots[index] = { ref: { current: initial === undefined ? null : initial } }
    return hookSlots[index].ref || hole
  },
  useMemo(factory, deps) {
    const index = cursor++
    const slot = hookSlots[index]
    if (slot && deps && sameDeps(slot.deps, deps)) return slot.value
    const value = factory()
    hookSlots[index] = { deps: deps || null, value: value }
    return value
  },
  useCallback(fn, deps) {
    const index = cursor++
    const slot = hookSlots[index]
    if (slot && deps && sameDeps(slot.deps, deps)) return slot.value
    hookSlots[index] = { deps: deps || null, value: fn }
    return fn
  },
  // 浅比较 props；相等就复用上次渲染结果（跟 React.memo 一致）。
  // 注意：memo 实例是按 key 分开的（跟 React 的 fiber 一致），不能所有卡片共用一份缓存。
  memo(component) {
    const wrapper = (props) => {
      let byKey = memoCache.get(component)
      if (!byKey) {
        byKey = new Map()
        memoCache.set(component, byKey)
      }
      const id = props.key === undefined ? '' : String(props.key)
      let entry = byKey.get(id)
      if (entry && shallowEqual(entry.props, props)) return entry.result
      const result = component(props)
      byKey.set(id, { props: props, result: result })
      return result
    }
    wrapper.__isMemo = true
    return wrapper
  },
}

function shallowEqual(a, b) {
  if (a === b) return true
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  for (const key of keysA) if (!Object.is(a[key], b[key])) return false
  return true
}

const sandbox = {
  console: { warn() {}, log() {}, error() {} },
  window: {
    __ModuleLoader__: { load(config) { sandbox.__loader = config } },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
    },
    innerWidth: 1400,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
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
  Blob: class Blob {},
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
}

vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

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

// ---------------------------------------------------------------- 量

function renderOnce() {
  elementCount = 0
  cardCount = 0
  cursor = 0
  registered.component()
}

// 预热，避免 JIT 冷启动污染第一轮
for (let i = 0; i < 5; i += 1) renderOnce()
memoCache = new WeakMap()

const rounds = []
for (let i = 0; i < ROUNDS; i += 1) {
  const started = process.hrtime.bigint()
  renderOnce()
  rounds.push({
    ms: Number(process.hrtime.bigint() - started) / 1e6,
    elements: elementCount,
    cards: cardCount,
  })
}
const steady = rounds.slice(1)
const avg = (key) => steady.reduce((sum, row) => sum + row[key], 0) / Math.max(1, steady.length)

console.log(
  JSON.stringify({
    notes: SIZE,
    rounds: ROUNDS,
    elementsFirstRender: rounds[0].elements,
    elementsSteady: Math.round(avg('elements')),
    cardsFirstRender: rounds[0].cards,
    cardsSteady: Number(avg('cards').toFixed(1)),
    msFirstRender: Number(rounds[0].ms.toFixed(2)),
    msSteady: Number(avg('ms').toFixed(2)),
  }),
)
