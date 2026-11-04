/**
 * dsh-sticky-notes 浏览器半侧。
 *
 * DSH 的 Web 端用 window.__ModuleLoader__.load({ id, factory }) 装载浏览器插件：
 * factory(require) 返回一个 Cordis 插件模块 { name, inject, apply }。
 * 这里把「左侧便签栏」注册进 shell.overlay（覆盖在所有列之上的浮动层），
 * 便签内容全部存在浏览器 localStorage，不经 Host、无网络请求。
 *
 * 约束：整个文件是普通副作用脚本，不能有顶层 ESM import / export
 * （react 由 factory 的 require 取得）。
 */
;(function () {
  'use strict'

  var LOADER = window.__ModuleLoader__
  if (!LOADER || typeof LOADER.load !== 'function') {
    console.error('[dsh-sticky-notes] 页面没有注入 __ModuleLoader__，便签栏无法加载')
    return
  }

  LOADER.load({
    id: 'dsh-sticky-notes',
    factory: function (require) {
      var module = { exports: {} }

      var React
      try {
        React = require('react')
      } catch (error) {
        console.error('[dsh-sticky-notes] react 不可用，便签栏无法加载：', error)
      }

      if (!React || typeof React.createElement !== 'function') {
        // 没有 React 就当作空插件：绝不能让浏览器半侧抛错拖垮整个页面。
        module.exports = {
          name: 'dsh-sticky-notes',
          inject: [],
          apply: function () {
            console.warn('[dsh-sticky-notes] 已跳过：react 模块缺失')
          },
        }
        return module.exports
      }

      var h = React.createElement
      var useCallback = React.useCallback
      var useEffect = React.useEffect
      var useMemo = React.useMemo
      var useRef = React.useRef
      var useState = React.useState

      // ---------------------------------------------------------------- 数据

      // 便签内容与面板开合分两个 key 存：内容要在多标签页之间同步，
      // 开合状态只属于当前页，混在一个 key 里会让两个标签页互相覆盖、来回写。
      var STORAGE_KEY = 'dsh-sticky-notes:v1'
      var OPEN_KEY = 'dsh-sticky-notes:open'
      var SAVE_DEBOUNCE_MS = 300
      var MAX_NOTES = 500
      // 便签到这个数量再显示搜索框，少的时候不占地方。
      var SEARCH_THRESHOLD = 6
      // 删除后的撤销窗口。
      var UNDO_MS = 5000

      /** 便签配色：卡片左侧的窄色条，配色名只存在数据里，样式由 class 决定。 */
      var COLOR_IDS = ['amber', 'sky', 'mint', 'rose', 'violet']

      function newId() {
        return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
      }

      function normalizeNote(raw) {
        if (!raw || typeof raw !== 'object') return null
        var text = typeof raw.text === 'string' ? raw.text : ''
        if (!text.trim() && !raw.id) return null
        var now = Date.now()
        return {
          id: typeof raw.id === 'string' && raw.id ? raw.id : newId(),
          text: text,
          color: COLOR_IDS.indexOf(raw.color) === -1 ? 'amber' : raw.color,
          pinned: raw.pinned === true,
          archived: raw.archived === true,
          archivedAt: typeof raw.archivedAt === 'number' ? raw.archivedAt : 0,
          createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : now,
          updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : now,
        }
      }

      function readNotes() {
        try {
          var raw = window.localStorage.getItem(STORAGE_KEY)
          if (!raw) return []
          var parsed = JSON.parse(raw)
          if (!parsed || typeof parsed !== 'object') return []
          return Array.isArray(parsed.notes) ? parsed.notes.map(normalizeNote).filter(Boolean).slice(0, MAX_NOTES) : []
        } catch (error) {
          console.warn('[dsh-sticky-notes] 读取本地便签失败，已按空数据启动：', error)
          return []
        }
      }

      function readOpen() {
        try {
          return window.localStorage.getItem(OPEN_KEY) === '1'
        } catch (error) {
          return false
        }
      }

      function readStore() {
        return { notes: readNotes(), open: readOpen() }
      }

      function writeNotes(notes) {
        try {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ notes: notes }))
        } catch (error) {
          console.warn('[dsh-sticky-notes] 便签保存失败（可能是存储空间已满）：', error)
        }
      }

      function writeOpen(open) {
        try {
          window.localStorage.setItem(OPEN_KEY, open ? '1' : '0')
        } catch (error) {
          // 开合状态存不下不影响便签本身，忽略。
        }
      }

      function sortNotes(notes) {
        return notes.slice().sort(function (a, b) {
          // 置顶的永远在上；同组里按最近改动排。
          if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1
          return b.updatedAt - a.updatedAt
        })
      }

      // ------------------------------------------------------------ 本机埋点
      //
      // 只落在 localStorage，不上报。导出 Markdown 时附在末尾，方便用一周后
      // 拿真实数据决定下一步优化顺序（而不是靠直觉）。
      var METRICS_KEY = 'dsh-sticky-notes:metrics:v1'
      var METRIC_KEYS = ['open', 'create', 'edit', 'delete', 'undo', 'pin', 'archive', 'unarchive', 'export', 'search']
      var METRIC_LABELS = {
        open: '打开面板',
        create: '新建便签',
        edit: '编辑便签',
        delete: '删除便签',
        undo: '撤销删除',
        pin: '置顶操作',
        archive: '归档',
        unarchive: '恢复归档',
        export: '导出',
        search: '搜索',
      }

      function readMetrics() {
        var empty = { since: Date.now(), counters: {} }
        try {
          var raw = window.localStorage.getItem(METRICS_KEY)
          if (!raw) return empty
          var parsed = JSON.parse(raw)
          if (!parsed || typeof parsed !== 'object') return empty
          var counters = {}
          for (var i = 0; i < METRIC_KEYS.length; i += 1) {
            var key = METRIC_KEYS[i]
            counters[key] = typeof parsed.counters === 'object' && parsed.counters ? Number(parsed.counters[key]) || 0 : 0
          }
          return { since: typeof parsed.since === 'number' ? parsed.since : Date.now(), counters: counters }
        } catch (error) {
          return empty
        }
      }

      function recordMetric(name) {
        if (METRIC_KEYS.indexOf(name) === -1) return
        try {
          var metrics = readMetrics()
          metrics.counters[name] = (metrics.counters[name] || 0) + 1
          window.localStorage.setItem(METRICS_KEY, JSON.stringify(metrics))
        } catch (error) {
          // 埋点失败绝不影响功能。
        }
      }

      // ---------------------------------------------------------------- 文案
      //
      // 接入 DSH 的 locale 服务：zh 是键集真源，en 逐键对齐；其余语言自动按 en 回退。
      // ctx.locale.register(ns, dicts) + ctx.locale.bind(ns) → t(key)。
      var NS = 'sticky-notes'

      var ZH = {
        name: '便签',
        'tab.title': '便签栏（Alt+Shift+N）',
        'tab.open': '打开便签栏',
        'sub.empty': '随手记',
        unit: '条',
        export: '导出为 Markdown',
        close: '收起便签栏',
        'close.esc': '收起便签栏（Esc）',
        'composer.placeholder': '写下此刻的想法…（Ctrl+Enter 记下）',
        'composer.aria': '新便签内容',
        saving: '保存中…',
        saved: '已自动保存到本机',
        save: '记下',
        'search.placeholder': '搜索便签…（Ctrl+K）',
        'search.aria': '搜索便签',
        'search.clear': '清除搜索',
        'empty.none': '还没有便签',
        'empty.none.sub': '上面写下想法，按 Ctrl+Enter 记下。',
        'empty.search': '没有匹配的便签',
        'empty.search.sub': '换个关键词，或清空搜索。',
        'empty.archived': '还没有归档的便签',
        'empty.archived.sub': '归档后随时能在这里找回来。',
        'note.placeholder': '空的便签…',
        'note.aria': '便签内容',
        'note.pinned': '置顶',
        'note.pin': '置顶这条便签',
        'note.unpin': '取消置顶',
        'note.color': '换个颜色',
        'note.delete': '删除这条便签（可撤销）',
        'note.archive': '归档这条便签',
        'note.restore': '恢复这条便签',
        'time.justNow': '刚刚',
        'time.minutesAgo': '分钟前',
        'time.hoursAgo': '小时前',
        'toast.deleted': '已删除 1 条便签',
        'toast.undo': '撤销',
        'filter.all': '全部',
        'filter.archived': '已归档',
        'metric.open': '打开面板',
        'metric.create': '新建便签',
        'metric.edit': '编辑便签',
        'metric.delete': '删除便签',
        'metric.undo': '撤销删除',
        'metric.pin': '置顶操作',
        'metric.archive': '归档',
        'metric.unarchive': '恢复归档',
        'metric.export': '导出',
        'metric.search': '搜索',
      }

      var EN = {
        name: 'Notes',
        'tab.title': 'Notes (Alt+Shift+N)',
        'tab.open': 'Open notes',
        'sub.empty': 'Jot something',
        unit: 'notes',
        export: 'Export as Markdown',
        close: 'Collapse notes',
        'close.esc': 'Collapse notes (Esc)',
        'composer.placeholder': 'Jot something… (Ctrl+Enter to save)',
        'composer.aria': 'New note',
        saving: 'Saving…',
        saved: 'Saved locally',
        save: 'Save',
        'search.placeholder': 'Search notes… (Ctrl+K)',
        'search.aria': 'Search notes',
        'search.clear': 'Clear search',
        'empty.none': 'No notes yet',
        'empty.none.sub': 'Write something above, press Ctrl+Enter to save.',
        'empty.search': 'No matching notes',
        'empty.search.sub': 'Try another keyword, or clear the search.',
        'empty.archived': 'Nothing archived yet',
        'empty.archived.sub': 'Archived notes stay here until you restore or delete them.',
        'note.placeholder': 'Empty note…',
        'note.aria': 'Note content',
        'note.pinned': 'Pinned',
        'note.pin': 'Pin this note',
        'note.unpin': 'Unpin this note',
        'note.color': 'Change color',
        'note.delete': 'Delete this note (undoable)',
        'note.archive': 'Archive this note',
        'note.restore': 'Restore this note',
        'time.justNow': 'just now',
        'time.minutesAgo': 'min ago',
        'time.hoursAgo': 'hr ago',
        'toast.deleted': '1 note deleted',
        'toast.undo': 'Undo',
        'filter.all': 'All',
        'filter.archived': 'Archived',
        'metric.open': 'Opened panel',
        'metric.create': 'Notes created',
        'metric.edit': 'Notes edited',
        'metric.delete': 'Notes deleted',
        'metric.undo': 'Undos',
        'metric.pin': 'Pin actions',
        'metric.archive': 'Archived',
        'metric.unarchive': 'Restored',
        'metric.export': 'Exports',
        'metric.search': 'Searches',
      }

      var dicts = { zh: ZH, en: EN }

      function fallbackT(key) {
        return Object.prototype.hasOwnProperty.call(ZH, key) ? ZH[key] : key
      }

      // ------------------------------------------------------------ 左列边界
      //
      // DSH 的会话列表列带 `data-dsh-sidebar-root`（写在 ui-sidebar 的列容器上），
      // 量它的右边界，便签栏就能「贴着左列右侧」展开，不遮挡会话列表。
      // 量不到就退回 0（此时按没有左列处理，不会比原来更糟）。
      function measureSidebarLeft() {
        try {
          if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return 0
          var column = document.querySelector('[data-dsh-sidebar-root]')
          if (!column || typeof column.getBoundingClientRect !== 'function') return 0
          var rect = column.getBoundingClientRect()
          var right = Math.round(rect ? rect.right : 0)
          if (!isFinite(right) || right < 0) return 0
          // 右边界要是超过视口的 70%，说明量到的不是左列，宁可退回 0。
          var viewport = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 0
          if (viewport > 0 && right > viewport * 0.7) return 0
          return right
        } catch (error) {
          return 0
        }
      }

      // ------------------------------------------------------------ 时间格式

      function pad2(n) {
        return (n < 10 ? '0' : '') + n
      }

      function formatTime(ts, now, labels) {
        var diff = now - ts
        if (!isFinite(diff) || diff < 0) diff = 0
        if (diff < 60 * 1000) return labels.justNow
        if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' ' + labels.minutesAgo
        if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' ' + labels.hoursAgo
        var d = new Date(ts)
        var sameYear = d.getFullYear() === new Date(now).getFullYear()
        var stamp = pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
        return sameYear ? stamp : d.getFullYear() + '-' + stamp
      }

      // -------------------------------------------------------------- 图标
      //
      // 优先用 DSH primitives 的 Fluent 图标（主题、尺寸、圆角一致）；取不到就退回手绘 SVG。
      // 「便签」与「撤销」没有对应的 primitives 图标，保持手绘。
      var primitives = null
      try {
        primitives = require('@deepseek-ai/dsh-client-ui-primitives')
      } catch (error) {
        console.warn('[dsh-sticky-notes] primitives 不可用，退回内置图标：', error && error.message)
      }

      function pick(primName, fallback, size) {
        if (primitives && typeof primitives[primName] === 'function') {
          return h(primitives[primName], { size: size })
        }
        return fallback(size)
      }

      function svg(children, size) {
        return h(
          'svg',
          {
            width: size || 16,
            height: size || 16,
            viewBox: '0 0 24 24',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.7,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': 'true',
            focusable: 'false',
          },
          children,
        )
      }

      function IconNote(size) {
        return svg(
          [
            h('path', { key: 'a', d: 'M5 3.5h8.5L19 9v11.5H5z' }),
            h('path', { key: 'b', d: 'M13.5 3.5V9H19' }),
            h('path', { key: 'c', d: 'M8.5 13h7M8.5 16.5h5' }),
          ],
          size,
        )
      }

      function IconPlus(size) {
        return pick('IconPlusOutlineRegular', function (s) {
          return svg([h('path', { key: 'a', d: 'M12 5.5v13M5.5 12h13' })], s)
        }, size)
      }

      function IconClose(size) {
        return pick('IconCloseOutlineRegular', function (s) {
          return svg([h('path', { key: 'a', d: 'M6.5 6.5l11 11M17.5 6.5l-11 11' })], s)
        }, size)
      }

      function IconTrash(size) {
        return pick('IconTrashOutlineRegular', function (s) {
          return svg(
            [
              h('path', { key: 'a', d: 'M4 7h16' }),
              h('path', { key: 'b', d: 'M9.5 7V4.5h5V7' }),
              h('path', { key: 'c', d: 'M6.5 7l1 12.5h9L17.5 7' }),
            ],
            s,
          )
        }, size)
      }

      function IconDownload(size) {
        return pick('IconDownloadOutlineRegular', function (s) {
          return svg(
            [
              h('path', { key: 'a', d: 'M12 3.5v10.5' }),
              h('path', { key: 'b', d: 'M8 10.5l4 4 4-4' }),
              h('path', { key: 'c', d: 'M4.5 19.5h15' }),
            ],
            s,
          )
        }, size)
      }

      function IconPin(size) {
        return pick('IconPinOutlineRegular', function (s) {
          return svg(
            [
              h('path', { key: 'a', d: 'M9 4h6l-1 5 3.2 3.2v1.3H6.8v-1.3L10 9z' }),
              h('path', { key: 'b', d: 'M12 13.5v6.5' }),
            ],
            s,
          )
        }, size)
      }

      function IconPinFilled(size) {
        return pick('IconPinFillRegular', function (s) {
          return svg(
            [
              h('path', { key: 'a', d: 'M9 4h6l-1 5 3.2 3.2v1.3H6.8v-1.3L10 9z' }),
              h('path', { key: 'b', d: 'M12 13.5v6.5' }),
            ],
            s,
          )
        }, size)
      }

      function IconSearch(size) {
        return pick('IconSearchOutlineRegular', function (s) {
          return svg(
            [
              h('path', { key: 'a', d: 'M10.5 4.2a6.3 6.3 0 1 0 0 12.6 6.3 6.3 0 0 0 0-12.6z' }),
              h('path', { key: 'b', d: 'M15.2 15.2L20 20' }),
            ],
            s,
          )
        }, size)
      }

      function IconUndo(size) {
        return svg(
          [
            h('path', { key: 'a', d: 'M7.5 5.5L4 9l3.5 3.5' }),
            h('path', { key: 'b', d: 'M4 9h9.5a5 5 0 0 1 0 10H9' }),
          ],
          size,
        )
      }

      function IconArchive(size) {
        return pick('IconArchiveOutlineRegular', function (s) {
          return svg(
            [
              h('path', { key: 'a', d: 'M5 4.5h14v3.5H5z' }),
              h('path', { key: 'b', d: 'M6 8v11h12V8' }),
              h('path', { key: 'c', d: 'M12 11.5v4M9.5 13.5L12 16l2.5-2.5' }),
            ],
            s,
          )
        }, size)
      }

      function IconUnarchive(size) {
        return pick('IconUnarchiveOutlineRegular', function (s) {
          return svg(
            [
              h('path', { key: 'a', d: 'M5 4.5h14v3.5H5z' }),
              h('path', { key: 'b', d: 'M6 8v11h12V8' }),
              h('path', { key: 'c', d: 'M12 16v-4M9.5 14.5L12 12l2.5 2.5' }),
            ],
            s,
          )
        }, size)
      }

      // --------------------------------------------------------- 自动高度输入

      function AutoTextarea(props) {
        var ref = useRef(null)
        useEffect(
          function () {
            var el = ref.current
            if (!el) return
            el.style.height = 'auto'
            el.style.height = Math.min(el.scrollHeight, 420) + 'px'
          },
          [props.value],
        )
        return h('textarea', Object.assign({}, props, { ref: ref }))
      }

      // ---------------------------------------------------------------- 卡片

      function NoteCard(props) {
        var note = props.note
        var tick = props.tick
        var t = props.t
        var timeLabels = props.timeLabels
        var onChange = props.onChange
        var onRemove = props.onRemove
        var onCycleColor = props.onCycleColor
        var onTogglePin = props.onTogglePin
        var onArchive = props.onArchive
        var onUnarchive = props.onUnarchive

        var archived = note.archived === true

        return h(
          'article',
          {
            className:
              'dsn-note dsn-c-' + note.color + (note.pinned && !archived ? ' is-pinned' : '') + (archived ? ' is-archived' : ''),
          },
          h(AutoTextarea, {
            className: 'dsn-note-input',
            value: note.text,
            rows: 2,
            spellCheck: false,
            placeholder: t('note.placeholder'),
            'aria-label': t('note.aria'),
            readOnly: archived,
            onChange: function (event) {
              onChange(note.id, event.target.value)
            },
          }),
          h(
            'div',
            { className: 'dsn-note-foot' },
            h('span', { className: 'dsn-time', title: new Date(note.updatedAt).toLocaleString() }, formatTime(note.updatedAt, tick, timeLabels)),
            note.pinned && !archived ? h('span', { className: 'dsn-pin-mark' }, t('note.pinned')) : null,
            archived ? h('span', { className: 'dsn-archived-mark' }, t('filter.archived')) : null,
            h('div', { className: 'dsn-spacer' }),
            archived
              ? null
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsn-icon-btn dsn-pin-btn' + (note.pinned ? ' is-pinned' : ''),
                    title: note.pinned ? t('note.unpin') : t('note.pin'),
                    'aria-label': note.pinned ? t('note.unpin') : t('note.pin'),
                    'aria-pressed': note.pinned ? 'true' : 'false',
                    onClick: function () {
                      onTogglePin(note.id)
                    },
                  },
                  note.pinned ? IconPinFilled(15) : IconPin(15),
                ),
            archived
              ? null
              : h('button', {
                  type: 'button',
                  className: 'dsn-dot-btn',
                  title: t('note.color'),
                  'aria-label': t('note.color'),
                  onClick: function () {
                    onCycleColor(note.id)
                  },
                }),
            h(
              'button',
              {
                type: 'button',
                className: 'dsn-icon-btn' + (archived ? ' dsn-restore' : ' dsn-archive'),
                title: archived ? t('note.restore') : t('note.archive'),
                'aria-label': archived ? t('note.restore') : t('note.archive'),
                onClick: function () {
                  if (archived) onUnarchive(note.id)
                  else onArchive(note.id)
                },
              },
              archived ? IconUnarchive(15) : IconArchive(15),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsn-icon-btn dsn-del',
                title: t('note.delete'),
                'aria-label': t('note.delete'),
                onClick: function () {
                  onRemove(note.id)
                },
              },
              IconTrash(15),
            ),
          ),
        )
      }

      // ---------------------------------------------------------------- 主组件

      function StickyNotesOverlay(props) {
        var ctx = props && props.ctx ? props.ctx : null
        var [store, setStore] = useState(readStore)
        var [draft, setDraft] = useState('')
        var [tick, setTick] = useState(Date.now())
        var [dirty, setDirty] = useState(false)
        var [query, setQuery] = useState('')
        // 'all' 或 'archived'：归档视图切换。
        var [view, setView] = useState('all')
        // 删除后 5 秒内可撤销：{ note } 或 null。
        var [undoState, setUndoState] = useState(null)
        // 左列右边界：便签栏贴着它展开，不压住会话列表。
        var [leftInset, setLeftInset] = useState(measureSidebarLeft)
        var saveTimer = useRef(0)
        var undoTimer = useRef(0)
        var panelRef = useRef(null)
        var searchRef = useRef(null)
        // 埋点去抖：同一条便签一次会话里只记一次「编辑」，搜索一次会话只记一次。
        var editedInSession = useRef({})
        var searchRecorded = useRef(false)
        // 最新一份状态，供「刷新/卸载前补写」这类拿不到闭包的路径读取。
        var latestStore = useRef(store)
        // 语言切换时重渲染一次，让 t() 重新绑定当前语言。
        var [, setLocaleTick] = useState(0)

        // 订阅语言切换；t 在每次渲染重新绑定，保证切换后立刻生效。
        useEffect(
          function () {
            if (ctx && ctx.locale && typeof ctx.locale.subscribe === 'function') {
              return ctx.locale.subscribe(function () {
                setLocaleTick(function (n) {
                  return n + 1
                })
              })
            }
            return undefined
          },
          [ctx],
        )

        var t = ctx && ctx.locale && typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : fallbackT

        var timeLabels = {
          justNow: t('time.justNow'),
          minutesAgo: t('time.minutesAgo'),
          hoursAgo: t('time.hoursAgo'),
        }

        var open = store.open
        var notes = useMemo(
          function () {
            return sortNotes(store.notes)
          },
          [store.notes],
        )

        var activeNotes = useMemo(
          function () {
            return notes.filter(function (note) {
              return note.archived !== true
            })
          },
          [notes],
        )
        var archivedNotes = useMemo(
          function () {
            return notes
              .filter(function (note) {
                return note.archived === true
              })
              .sort(function (a, b) {
                return (b.archivedAt || 0) - (a.archivedAt || 0)
              })
          },
          [notes],
        )

        var baseList = view === 'archived' ? archivedNotes : activeNotes
        var filteredNotes = useMemo(
          function () {
            var keyword = query.trim().toLowerCase()
            if (!keyword) return baseList
            return baseList.filter(function (note) {
              return note.text.toLowerCase().indexOf(keyword) !== -1
            })
          },
          [baseList, query],
        )
        var searchable = notes.length >= SEARCH_THRESHOLD

        // 左列宽度会变（拖动分隔条、折叠成 rail），跟着量。
        useEffect(
          function () {
            function sync() {
              var next = measureSidebarLeft()
              setLeftInset(function (prev) {
                return prev === next ? prev : next
              })
            }
            sync()
            window.addEventListener('resize', sync)
            var column =
              typeof document !== 'undefined' && typeof document.querySelector === 'function'
                ? document.querySelector('[data-dsh-sidebar-root]')
                : null
            var observer = null
            if (column && typeof window.ResizeObserver === 'function') {
              observer = new window.ResizeObserver(sync)
              observer.observe(column)
            }
            return function () {
              window.removeEventListener('resize', sync)
              if (observer) observer.disconnect()
            }
          },
          [open],
        )

        useEffect(
          function () {
            latestStore.current = store
          },
          [store],
        )

        // 内容变化 → 去抖写回 localStorage，顺便维护「未保存」小提示。
        useEffect(
          function () {
            setDirty(true)
            if (saveTimer.current) window.clearTimeout(saveTimer.current)
            saveTimer.current = window.setTimeout(function () {
              writeNotes(latestStore.current.notes)
              setDirty(false)
            }, SAVE_DEBOUNCE_MS)
            return function () {
              if (saveTimer.current) window.clearTimeout(saveTimer.current)
            }
          },
          [store.notes],
        )

        // 面板开合单独存，且只在变化时写一次。
        useEffect(
          function () {
            writeOpen(open)
          },
          [open],
        )

        // 立刻落盘：刷新、关页面、插件卸载时不能丢最后几个字。
        useEffect(function () {
          function flushNow() {
            if (saveTimer.current) {
              window.clearTimeout(saveTimer.current)
              saveTimer.current = 0
            }
            writeNotes(latestStore.current.notes)
          }
          window.addEventListener('pagehide', flushNow)
          window.addEventListener('beforeunload', flushNow)
          return function () {
            window.removeEventListener('pagehide', flushNow)
            window.removeEventListener('beforeunload', flushNow)
            flushNow()
          }
        }, [])

        // 多标签页/多窗口同步：另一个页面改了便签，这边跟着刷新内容（不动面板开合）。
        useEffect(function () {
          function onStorage(event) {
            if (event.key !== STORAGE_KEY) return
            var next = readNotes()
            setStore(function (prev) {
              // 内容一致就不更新：否则两边会互相回写同一个 key。
              if (JSON.stringify(prev.notes) === JSON.stringify(next)) return prev
              return { notes: next, open: prev.open }
            })
            setDirty(false)
          }
          window.addEventListener('storage', onStorage)
          return function () {
            window.removeEventListener('storage', onStorage)
          }
        }, [])

        // 相对时间每分钟刷新一次。
        useEffect(
          function () {
            if (!open) return undefined
            var timer = window.setInterval(function () {
              setTick(Date.now())
            }, 30000)
            return function () {
              window.clearInterval(timer)
            }
          },
          [open],
        )

        var close = useCallback(function () {
          setQuery('')
          setView('all')
          setStore(function (prev) {
            return prev.open ? { notes: prev.notes, open: false } : prev
          })
        }, [])

        var openPanel = useCallback(function () {
          setStore(function (prev) {
            return prev.open ? prev : { notes: prev.notes, open: true }
          })
          setTick(Date.now())
        }, [])

        var toggle = useCallback(
          function () {
            if (open) close()
            else openPanel()
          },
          [open, close, openPanel],
        )

        // Esc：有搜索词先清搜索，再按一次才收起；Ctrl/Cmd+K 聚焦搜索。
        useEffect(
          function () {
            if (!open) return undefined
            function onKeyDown(event) {
              if (event.key === 'Escape') {
                event.stopPropagation()
                if (query) {
                  setQuery('')
                  return
                }
                close()
                return
              }
              if ((event.ctrlKey || event.metaKey) && (event.key === 'k' || event.key === 'K')) {
                var input = searchRef.current
                if (!input) return
                event.preventDefault()
                event.stopPropagation()
                input.focus()
                if (typeof input.select === 'function') input.select()
              }
            }
            window.addEventListener('keydown', onKeyDown, true)
            return function () {
              window.removeEventListener('keydown', onKeyDown, true)
            }
          },
          [open, close, query],
        )

        // 点面板外面收起。没有全屏遮罩，所以点一下别处既能让面板消失、又不会拦掉那次点击。
        useEffect(
          function () {
            if (!open || typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
            function onPointerDown(event) {
              var panel = panelRef.current
              if (!panel) return
              var target = event.target
              if (target && typeof panel.contains === 'function' && panel.contains(target)) return
              close()
            }
            document.addEventListener('pointerdown', onPointerDown, true)
            return function () {
              document.removeEventListener('pointerdown', onPointerDown, true)
            }
          },
          [open, close],
        )

        // Alt+Shift+N 全局开关。
        useEffect(function () {
          function onKeyDown(event) {
            if (event.altKey && event.shiftKey && (event.key === 'N' || event.key === 'n')) {
              event.preventDefault()
              event.stopPropagation()
              toggle()
            }
          }
          window.addEventListener('keydown', onKeyDown, true)
          return function () {
            window.removeEventListener('keydown', onKeyDown, true)
          }
        }, [toggle])

        // 打开时把焦点放到输入框；首帧不抢焦点（页面加载时可能正有别的输入框在用）。
        var firstRender = useRef(true)
        useEffect(
          function () {
            if (firstRender.current) {
              firstRender.current = false
              return
            }
            if (!open) return
            var panel = panelRef.current
            if (!panel) return
            var input = panel.querySelector('.dsn-draft')
            if (input && typeof input.focus === 'function') input.focus()
          },
          [open],
        )

        // 打开一次记一次「打开」；顺便复位「本次会话已记过搜索」的标记。
        useEffect(
          function () {
            if (!open) return
            recordMetric('open')
            searchRecorded.current = false
          },
          [open],
        )

        // 卸载时清掉撤销计时器，避免对已卸载组件 setState。
        useEffect(function () {
          return function () {
            if (undoTimer.current) window.clearTimeout(undoTimer.current)
          }
        }, [])

        var addNote = useCallback(function (text) {
          var value = String(text == null ? '' : text).trim()
          if (!value) return
          var now = Date.now()
          setStore(function (prev) {
            var note = {
              id: newId(),
              text: value,
              color: COLOR_IDS[Math.floor(Math.random() * COLOR_IDS.length)] || 'amber',
              pinned: false,
              archived: false,
              archivedAt: 0,
              createdAt: now,
              updatedAt: now,
            }
            return { notes: [note].concat(prev.notes).slice(0, MAX_NOTES), open: true }
          })
          setDraft('')
          setTick(now)
          recordMetric('create')
        }, [])

        function findNote(id) {
          for (var i = 0; i < store.notes.length; i += 1) {
            if (store.notes[i].id === id) return store.notes[i]
          }
          return null
        }

        function updateNote(id, text) {
          setStore(function (prev) {
            var changed = false
            var next = prev.notes.map(function (note) {
              if (note.id !== id) return note
              if (note.text === text) return note
              changed = true
              return { id: note.id, text: text, color: note.color, pinned: note.pinned, archived: note.archived, archivedAt: note.archivedAt, createdAt: note.createdAt, updatedAt: Date.now() }
            })
            return changed ? { notes: next, open: prev.open } : prev
          })
          if (editedInSession.current[id] !== true) {
            editedInSession.current[id] = true
            recordMetric('edit')
          }
        }

        function cycleColor(id) {
          setStore(function (prev) {
            var next = prev.notes.map(function (note) {
              if (note.id !== id) return note
              var index = COLOR_IDS.indexOf(note.color)
              var color = COLOR_IDS[(index + 1) % COLOR_IDS.length]
              return { id: note.id, text: note.text, color: color, pinned: note.pinned, archived: note.archived, archivedAt: note.archivedAt, createdAt: note.createdAt, updatedAt: note.updatedAt }
            })
            return { notes: next, open: prev.open }
          })
        }

        function togglePin(id) {
          if (!findNote(id)) return
          setStore(function (prev) {
            var next = prev.notes.map(function (note) {
              if (note.id !== id) return note
              return { id: note.id, text: note.text, color: note.color, pinned: !note.pinned, archived: note.archived, archivedAt: note.archivedAt, createdAt: note.createdAt, updatedAt: note.updatedAt }
            })
            return { notes: next, open: prev.open }
          })
          recordMetric('pin')
        }

        function archiveNote(id) {
          if (!findNote(id)) return
          var now = Date.now()
          setStore(function (prev) {
            var next = prev.notes.map(function (note) {
              if (note.id !== id) return note
              return { id: note.id, text: note.text, color: note.color, pinned: note.pinned, archived: true, archivedAt: now, createdAt: note.createdAt, updatedAt: note.updatedAt }
            })
            return { notes: next, open: prev.open }
          })
          recordMetric('archive')
        }

        function unarchiveNote(id) {
          if (!findNote(id)) return
          setStore(function (prev) {
            var next = prev.notes.map(function (note) {
              if (note.id !== id) return note
              return { id: note.id, text: note.text, color: note.color, pinned: note.pinned, archived: false, archivedAt: 0, createdAt: note.createdAt, updatedAt: note.updatedAt }
            })
            return { notes: next, open: prev.open }
          })
          recordMetric('unarchive')
        }

        // 删除立即生效，但给 5 秒撤销窗口：比「再点一次确认」更不打断思路，也更可逆。
        function removeNote(id) {
          var target = findNote(id)
          if (!target) return
          setStore(function (prev) {
            return { notes: prev.notes.filter(function (note) { return note.id !== id }), open: prev.open }
          })
          setUndoState({ note: target })
          if (undoTimer.current) window.clearTimeout(undoTimer.current)
          undoTimer.current = window.setTimeout(function () {
            undoTimer.current = 0
            setUndoState(null)
          }, UNDO_MS)
          recordMetric('delete')
        }

        function undoDelete() {
          var pending = undoState
          if (!pending) return
          if (undoTimer.current) {
            window.clearTimeout(undoTimer.current)
            undoTimer.current = 0
          }
          setStore(function (prev) {
            var exists = false
            for (var i = 0; i < prev.notes.length; i += 1) {
              if (prev.notes[i].id === pending.note.id) exists = true
            }
            if (exists) return prev
            return { notes: prev.notes.concat([pending.note]), open: prev.open }
          })
          setUndoState(null)
          recordMetric('undo')
        }

        var exportNotes = useCallback(function () {
          var rows = sortNotes(store.notes).filter(function (note) {
            return note.text.trim().length > 0
          })
          if (!rows.length) return
          // 先记一次导出，导出的统计里就包含这一次。
          recordMetric('export')
          var lines = ['# ' + t('name'), '']
          rows.forEach(function (note) {
            var marks = []
            if (note.pinned) marks.push(t('note.pinned'))
            if (note.archived) marks.push(t('filter.archived'))
            lines.push('## ' + new Date(note.createdAt).toLocaleString() + (marks.length ? ' · ' + marks.join(' · ') : ''))
            lines.push('')
            lines.push(note.text)
            lines.push('')
          })

          // 本机埋点一并导出：用一周后按真实数据决定下一步，而不是继续凭直觉。
          var metrics = readMetrics()
          var sinceText = new Date(metrics.since).toLocaleString()
          lines.push('---', '', '## 使用统计（本机，可删除）', '', '统计自 ' + sinceText + '：', '')
          for (var i = 0; i < METRIC_KEYS.length; i += 1) {
            var key = METRIC_KEYS[i]
            var label = t('metric.' + key)
            if (!label || label === 'metric.' + key) label = METRIC_LABELS[key]
            lines.push('- ' + label + '：' + (metrics.counters[key] || 0) + ' 次')
          }
          lines.push('')

          try {
            var blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' })
            var url = URL.createObjectURL(blob)
            var link = document.createElement('a')
            var stamp = new Date()
            link.href = url
            link.download =
              'sticky-notes-' +
              stamp.getFullYear() +
              pad2(stamp.getMonth() + 1) +
              pad2(stamp.getDate()) +
              '-' +
              pad2(stamp.getHours()) +
              pad2(stamp.getMinutes()) +
              '.md'
            document.body.appendChild(link)
            link.click()
            window.setTimeout(function () {
              link.remove()
              URL.revokeObjectURL(url)
            }, 0)
          } catch (error) {
            console.warn('[dsh-sticky-notes] 导出失败：', error)
          }
        }, [store.notes])

        var visibleCount = activeNotes.filter(function (note) {
          return note.text.trim().length > 0
        }).length

        var tab = h(
          'button',
          {
            type: 'button',
            className: 'dsn-tab',
            title: t('tab.title'),
            'aria-label': t('tab.open'),
            'aria-expanded': open ? 'true' : 'false',
            onClick: toggle,
          },
          h('span', { className: 'dsn-tab-icon' }, IconNote(15)),
          h('span', { className: 'dsn-tab-text' }, t('name')),
          visibleCount > 0 ? h('span', { className: 'dsn-tab-count' }, visibleCount > 99 ? '99+' : String(visibleCount)) : null,
        )

        // 收起时连面板的元素都不构造：左边缘的便签标签是唯一常驻的部分。
        var panel = !open
          ? null
          : h(
          'aside',
          { className: 'dsn-panel', role: 'dialog', 'aria-label': t('name'), ref: panelRef },
          h(
            'div',
            { className: 'dsn-head' },
            h('div', { className: 'dsn-heading' }, h('span', { className: 'dsn-head-icon' }, IconNote(15)), h('span', { className: 'dsn-title' }, t('name')), h('span', { className: 'dsn-sub' }, visibleCount > 0 ? visibleCount + ' ' + t('unit') : t('sub.empty'))),
            h(
              'div',
              { className: 'dsn-head-actions' },
              h(
                'button',
                { type: 'button', className: 'dsn-icon-btn', title: t('export'), 'aria-label': t('export'), onClick: exportNotes, disabled: visibleCount === 0 },
                IconDownload(15),
              ),
              h('button', { type: 'button', className: 'dsn-icon-btn', title: t('close.esc'), 'aria-label': t('close'), onClick: close }, IconClose(15)),
            ),
          ),
          h(
            'div',
            { className: 'dsn-composer' },
            h(AutoTextarea, {
              className: 'dsn-input dsn-draft',
              value: draft,
              rows: 3,
              spellCheck: false,
              placeholder: t('composer.placeholder'),
              'aria-label': t('composer.aria'),
              onChange: function (event) {
                setDraft(event.target.value)
              },
              onKeyDown: function (event) {
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                  event.preventDefault()
                  addNote(draft)
                }
              },
            }),
            h(
              'div',
              { className: 'dsn-composer-foot' },
              h('span', { className: 'dsn-hint' }, dirty ? t('saving') : t('saved')),
              h(
                'button',
                { type: 'button', className: 'dsn-save', disabled: draft.trim().length === 0, onClick: function () { addNote(draft) } },
                IconPlus(13),
                h('span', null, t('save')),
              ),
            ),
          ),
          notes.length > 0
            ? h(
                'div',
                { className: 'dsn-filter', role: 'tablist', 'aria-label': t('filter.all') + ' / ' + t('filter.archived') },
                h(
                  'button',
                  {
                    type: 'button',
                    role: 'tab',
                    className: 'dsn-filter-btn' + (view === 'all' ? ' is-active' : ''),
                    'aria-selected': view === 'all' ? 'true' : 'false',
                    onClick: function () {
                      setView('all')
                      setQuery('')
                    },
                  },
                  t('filter.all') + ' ' + activeNotes.length,
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    role: 'tab',
                    className: 'dsn-filter-btn' + (view === 'archived' ? ' is-active' : ''),
                    'aria-selected': view === 'archived' ? 'true' : 'false',
                    onClick: function () {
                      setView('archived')
                      setQuery('')
                    },
                  },
                  t('filter.archived') + ' ' + archivedNotes.length,
                ),
              )
            : null,
          searchable
            ? h(
                'div',
                { className: 'dsn-search', role: 'search' },
                h('span', { className: 'dsn-search-icon' }, IconSearch(14)),
                h('input', {
                  ref: searchRef,
                  type: 'search',
                  className: 'dsn-search-input',
                  value: query,
                  placeholder: t('search.placeholder'),
                  'aria-label': t('search.aria'),
                  onChange: function (event) {
                    setQuery(event.target.value)
                    if (!searchRecorded.current) {
                      searchRecorded.current = true
                      recordMetric('search')
                    }
                  },
                }),
                query
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsn-icon-btn dsn-search-clear',
                        title: t('search.clear'),
                        'aria-label': t('search.clear'),
                        onClick: function () {
                          setQuery('')
                          var input = searchRef.current
                          if (input && typeof input.focus === 'function') input.focus()
                        },
                      },
                      IconClose(13),
                    )
                  : null,
              )
            : null,
          h(
            'div',
            { className: 'dsn-list' + (undoState ? ' has-toast' : '') },
            filteredNotes.length === 0
              ? h(
                  'div',
                  { className: 'dsn-empty' },
                  h('div', { className: 'dsn-empty-title' }, query ? t('empty.search') : view === 'archived' ? t('empty.archived') : t('empty.none')),
                  h('div', { className: 'dsn-empty-sub' }, query ? t('empty.search.sub') : view === 'archived' ? t('empty.archived.sub') : t('empty.none.sub')),
                )
              : filteredNotes.map(function (note) {
                  return h(NoteCard, {
                    key: note.id,
                    note: note,
                    tick: tick,
                    t: t,
                    timeLabels: timeLabels,
                    onChange: updateNote,
                    onRemove: removeNote,
                    onCycleColor: cycleColor,
                    onTogglePin: togglePin,
                    onArchive: archiveNote,
                    onUnarchive: unarchiveNote,
                  })
                }),
          ),
          undoState
            ? h(
                'div',
                { className: 'dsn-toast', role: 'status', 'aria-live': 'polite' },
                h('span', { className: 'dsn-toast-text' }, t('toast.deleted')),
                h(
                  'button',
                  { type: 'button', className: 'dsn-toast-undo', onClick: undoDelete },
                  IconUndo(13),
                  h('span', null, t('toast.undo')),
                ),
              )
            : null,
        )

        return h(
          'div',
          { className: 'dsn-root', style: { '--dsn-left': leftInset + 'px' } },
          // 展开时不再有全屏遮罩，也不渲染标签：面板本身贴在左列右侧。
          open ? null : tab,
          open ? panel : null,
        )
      }

      // 兜底错误边界：本组件出错时只让便签栏消失，不允许影响 DSH 自身界面。
      class StickyNotesBoundary extends React.Component {
        constructor(props) {
          super(props)
          this.state = { failed: false }
        }

        static getDerivedStateFromError() {
          return { failed: true }
        }

        componentDidCatch(error) {
          console.error('[dsh-sticky-notes] 便签栏渲染失败，已隐藏：', error)
        }

        render() {
          if (this.state.failed) return null
          return this.props.children
        }
      }

      function StickyNotesRoot(props) {
        return h(StickyNotesBoundary, null, h(StickyNotesOverlay, { ctx: props && props.ctx }))
      }

      // ---------------------------------------------------------------- 样式
      //
      // 颜色全部走 DSH 主题 token，兜底值取的是官方调色板的真实取值
      // （light：label-primary #0f1115 / label-secondary #61666b / layer-1 #fff）。
      // 关键点：品牌色在 light 下是近黑、dark 下是近白，所以压在品牌色上的文字
      // 必须用「反色」bg-layer-1，直接写 #fff 在暗色主题下等于白底白字。
      var CSS = [
        '.dsn-root{position:fixed;inset:0;z-index:2147483000;pointer-events:none;--dsn-left:0px;--dsn-fg:var(--dsw-alias-label-primary,#0f1115);--dsn-fg-2:var(--dsw-alias-label-secondary,#61666b);--dsn-surface:var(--dsw-alias-bg-layer-1,#fff);--dsn-accent:var(--dsw-alias-brand-primary,#0f1115);--dsn-on-accent:var(--dsw-alias-bg-layer-1,#fff);--dsn-line:var(--dsw-alias-border-l1,rgba(0,0,0,.1));--dsn-ring:rgba(0,0,0,.3);font-family:inherit;color:var(--dsn-fg);-webkit-font-smoothing:antialiased}',
        'body[data-ds-dark-theme] .dsn-root{--dsn-ring:rgba(255,255,255,.42)}',
        '.dsn-root *,.dsn-root *::before,.dsn-root *::after{box-sizing:border-box}',
        '.dsn-tab{position:absolute;left:var(--dsn-left);top:50%;transform:translateY(-50%);pointer-events:auto;display:flex;flex-direction:column;align-items:center;gap:7px;width:32px;padding:13px 0 11px;margin:0;border:1px solid var(--dsn-line);border-left:0;border-radius:0 13px 13px 0;background:var(--dsn-surface);color:var(--dsn-fg-2);box-shadow:2px 2px 14px rgba(0,0,0,.14);cursor:pointer;font:inherit;transition:width .15s ease,color .15s ease,box-shadow .15s ease}',
        '.dsn-tab:hover{width:36px;color:var(--dsn-fg);box-shadow:2px 2px 18px rgba(0,0,0,.2)}',
        '.dsn-tab:focus-visible{outline:2px solid var(--dsn-accent);outline-offset:2px}',
        '.dsn-tab-icon{display:grid;place-items:center;opacity:.9}',
        '.dsn-tab-text{writing-mode:vertical-rl;letter-spacing:.22em;font-size:11px;line-height:1;opacity:.9}',
        '.dsn-tab-count{display:grid;place-items:center;min-width:17px;height:17px;padding:0 4px;border-radius:9px;background:var(--dsn-accent);color:var(--dsn-on-accent);font-size:10px;font-weight:650;line-height:1;font-variant-numeric:tabular-nums}',
        '.dsn-panel{position:absolute;left:var(--dsn-left);top:0;bottom:0;width:min(300px,calc(100vw - var(--dsn-left) - 24px));pointer-events:auto;display:flex;flex-direction:column;min-height:0;background:var(--dsn-surface);border-right:1px solid var(--dsn-line);box-shadow:10px 0 34px rgba(0,0,0,.18);animation:dsn-slide .12s ease-out}',
        '@keyframes dsn-slide{from{transform:translateX(-12px);opacity:.4}to{transform:none;opacity:1}}',
        '.dsn-head{display:flex;align-items:center;gap:10px;padding:14px 10px 10px 16px}',
        '.dsn-heading{display:flex;align-items:center;gap:8px;min-width:0}',
        '.dsn-head-icon{display:grid;place-items:center;color:var(--dsn-fg-2);opacity:.95;flex:0 0 auto}',
        '.dsn-title{font-size:15px;font-weight:650;letter-spacing:.02em}',
        '.dsn-sub{font-size:11px;color:var(--dsn-fg-2);align-self:baseline}',
        '.dsn-head-actions{margin-left:auto;display:flex;align-items:center;gap:2px}',
        '.dsn-icon-btn{display:grid;place-items:center;width:32px;height:32px;padding:0;border:0;border-radius:9px;background:transparent;color:var(--dsn-fg-2);cursor:pointer;font:inherit;transition:background .12s ease,color .12s ease}',
        '.dsn-icon-btn:hover:not(:disabled){background:rgba(127,127,127,.16);color:var(--dsn-fg)}',
        '.dsn-icon-btn:disabled{opacity:.38;cursor:default}',
        '.dsn-icon-btn:focus-visible{outline:2px solid var(--dsn-accent);outline-offset:1px}',
        '.dsn-del.is-confirming{color:var(--dsw-alias-state-error-primary,#e5484d);background:rgba(229,72,77,.14)}',
        '.dsn-composer{padding:0 14px 10px;display:flex;flex-direction:column;gap:8px}',
        '.dsn-input{width:100%;resize:none;border:1px solid var(--dsn-line);border-radius:11px;padding:9px 11px;font:inherit;font-size:13px;line-height:1.55;background:rgba(127,127,127,.08);color:inherit;transition:border-color .12s ease,box-shadow .12s ease}',
        '.dsn-input::placeholder{color:var(--dsn-fg-2);opacity:.85}',
        '.dsn-input:focus{outline:none;border-color:var(--dsn-accent);box-shadow:0 0 0 3px rgba(127,127,127,.2)}',
        '.dsn-search{display:flex;align-items:center;gap:6px;margin:0 14px 8px;padding:0 6px 0 9px;border:1px solid var(--dsn-line);border-radius:9px;background:rgba(127,127,127,.06);min-height:32px}',
        '.dsn-search:focus-within{border-color:var(--dsn-accent)}',
        '.dsn-search-icon{display:grid;place-items:center;color:var(--dsn-fg-2);flex:0 0 auto}',
        '.dsn-search-input{flex:1 1 auto;min-width:0;border:0;background:transparent;color:inherit;font:inherit;font-size:12.5px;padding:6px 0;outline:none}',
        '.dsn-search-input::placeholder{color:var(--dsn-fg-2);opacity:.85}',
        '.dsn-search-input::-webkit-search-cancel-button{display:none}',
        '.dsn-search-clear{width:24px;height:24px;border-radius:6px}',
        '.dsn-filter{display:flex;gap:6px;margin:0 14px 8px}',
        '.dsn-filter-btn{display:inline-flex;align-items:center;gap:5px;min-height:26px;padding:3px 11px;border:1px solid var(--dsn-line);border-radius:999px;background:transparent;color:var(--dsn-fg-2);font:inherit;font-size:11.5px;font-variant-numeric:tabular-nums;cursor:pointer;transition:background .12s ease,color .12s ease}',
        '.dsn-filter-btn:hover{background:rgba(127,127,127,.12);color:var(--dsn-fg)}',
        '.dsn-filter-btn.is-active{background:var(--dsn-accent);color:var(--dsn-on-accent);border-color:var(--dsn-accent)}',
        '.dsn-filter-btn:focus-visible{outline:2px solid var(--dsn-accent);outline-offset:1px}',
        '.dsn-composer-foot{display:flex;align-items:center;gap:8px}',
        '.dsn-hint{font-size:11px;color:var(--dsn-fg-2);margin-right:auto}',
        '.dsn-save{display:inline-flex;align-items:center;gap:5px;min-height:32px;padding:6px 14px;border:0;border-radius:9px;background:var(--dsn-accent);color:var(--dsn-on-accent);font:inherit;font-size:12px;font-weight:650;cursor:pointer;transition:filter .12s ease,transform .12s ease}',
        '.dsn-save:hover:not(:disabled){filter:brightness(.94);transform:translateY(-1px)}',
        '.dsn-save:disabled{opacity:.42;cursor:default;transform:none;filter:none}',
        '.dsn-list{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:2px 14px 16px;display:flex;flex-direction:column;gap:9px;scrollbar-width:thin}',
        '.dsn-list.has-toast{padding-bottom:64px}',
        '.dsn-list::-webkit-scrollbar{width:8px}',
        '.dsn-list::-webkit-scrollbar-thumb{background:rgba(127,127,127,.32);border-radius:4px}',
        '.dsn-note{--dsn-sticky:#f0b13a;position:relative;border:1px solid var(--dsn-line);border-left:3px solid var(--dsn-sticky);border-radius:11px;background:rgba(127,127,127,.08);padding:7px 8px 4px 10px}',
        '.dsn-c-amber{--dsn-sticky:#f0b13a}',
        '.dsn-c-sky{--dsn-sticky:#4f9dff}',
        '.dsn-c-mint{--dsn-sticky:#3fbd8b}',
        '.dsn-c-rose{--dsn-sticky:#f4728f}',
        '.dsn-c-violet{--dsn-sticky:#a58bfa}',
        '.dsn-note-input{width:100%;border:0;background:transparent;color:inherit;font:inherit;font-size:13px;line-height:1.55;resize:none;padding:2px 2px 0;overflow:hidden;display:block}',
        '.dsn-note-input:focus{outline:none}',
        '.dsn-note-input::placeholder{color:var(--dsn-fg-2);opacity:.85}',
        '.dsn-note-foot{display:flex;align-items:center;gap:3px;padding:1px 0 2px 2px;min-height:28px}',
        '.dsn-time{font-size:11px;color:var(--dsn-fg-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.dsn-pin-mark{font-size:9.5px;line-height:1.6;color:var(--dsn-fg-2);background:rgba(127,127,127,.16);border-radius:6px;padding:0 5px;white-space:nowrap}',
        '.dsn-pin-btn.is-pinned{color:var(--dsn-fg);background:rgba(127,127,127,.18)}',
        '.dsn-note.is-pinned{box-shadow:inset 0 0 0 1px rgba(127,127,127,.1)}',
        '.dsn-note.is-archived{opacity:.62}',
        '.dsn-note.is-archived .dsn-note-input{cursor:default}',
        '.dsn-archived-mark{font-size:9.5px;line-height:1.6;color:var(--dsn-fg-2);background:rgba(127,127,127,.16);border-radius:6px;padding:0 5px;white-space:nowrap}',
        '.dsn-spacer{flex:1 1 auto}',
        '.dsn-dot-btn{display:grid;place-items:center;width:24px;height:24px;padding:0;border:0;border-radius:50%;background:transparent;cursor:pointer;transition:background .12s ease}',
        '.dsn-dot-btn::after{content:"";width:12px;height:12px;border-radius:50%;background:var(--dsn-sticky);box-shadow:0 0 0 1.5px var(--dsn-ring);transition:transform .12s ease}',
        '.dsn-dot-btn:hover{background:rgba(127,127,127,.16)}',
        '.dsn-dot-btn:hover::after{transform:scale(1.14)}',
        '.dsn-dot-btn:focus-visible{outline:2px solid var(--dsn-accent);outline-offset:1px}',
        '.dsn-note-foot .dsn-icon-btn{width:28px;height:28px;border-radius:7px}',
        '.dsn-empty{padding:26px 12px;text-align:center;line-height:1.8}',
        '.dsn-empty-title{font-size:13px;font-weight:650;color:var(--dsn-fg)}',
        '.dsn-empty-sub{font-size:11.5px;color:var(--dsn-fg-2)}',
        '.dsn-toast{position:absolute;left:12px;right:12px;bottom:12px;display:flex;align-items:center;gap:8px;padding:8px 8px 8px 12px;border-radius:10px;background:var(--dsn-accent);color:var(--dsn-on-accent);box-shadow:0 8px 24px rgba(0,0,0,.24);animation:dsn-toast-in .12s ease-out}',
        '.dsn-toast-text{font-size:12px;margin-right:auto}',
        '.dsn-toast-undo{display:inline-flex;align-items:center;gap:4px;min-height:24px;border:0;border-radius:7px;padding:3px 9px;background:transparent;color:inherit;font:inherit;font-size:12px;font-weight:650;cursor:pointer}',
        '.dsn-toast-undo:hover{background:rgba(127,127,127,.24)}',
        '.dsn-toast-undo:focus-visible{outline:2px solid var(--dsn-on-accent);outline-offset:1px}',
        '@keyframes dsn-toast-in{from{transform:translateY(6px);opacity:0}to{transform:none;opacity:1}}',
        '@media (prefers-reduced-motion: reduce){.dsn-panel,.dsn-toast{animation:none}.dsn-tab,.dsn-save,.dsn-dot-btn,.dsn-dot-btn::after{transition:none}}',
      ].join('\n')

      // ---------------------------------------------------------------- 插件

      var name = 'dsh-sticky-notes'
      var inject = ['slots', 'locale']

      function apply(ctx) {
        // 注册文案字典：zh 是键集真源，en 对齐，其余语言按 en 回退。
        ctx.effect(
          function () {
            ctx.locale.register(NS, dicts)
          },
          'dsh-sticky-notes: i18n',
        )

        ctx.effect(function () {
          var style = document.createElement('style')
          style.setAttribute('data-dsh-sticky-notes', '')
          style.textContent = CSS
          document.head.appendChild(style)
          return function () {
            style.remove()
          }
        }, 'dsh-sticky-notes: styles')

        ctx.slots.inject('shell.overlay', function* () {
          yield ctx.slots.register({ name: 'shell.overlay', id: 'sticky-notes', order: 860 }, function () {
            return h(StickyNotesRoot, { ctx: ctx })
          })
        })
      }

      module.exports = { apply: apply, inject: inject, name: name }
      return module.exports
    },
  })
})()
