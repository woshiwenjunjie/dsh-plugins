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

  // 包名要出现在三处身份里：loader id、模块 name、以及失败兜底模块的 name。
  // 只写一处会「改名后忘了改」——0.1.10 改包名就是这么把浏览器半侧弄坏的。
  var PKG_NAME = '@woshiwenjunjie/dsh-sticky-notes'

  var LOADER = window.__ModuleLoader__
  if (!LOADER || typeof LOADER.load !== 'function') {
    console.error('[dsh-sticky-notes] 页面没有注入 __ModuleLoader__，便签栏无法加载')
    return
  }

  LOADER.load({
    // 必须等于 package.json 的 name：Web 端按「包名」到模块表里取浏览器半侧，
    // 写成短名（改名前的 dsh-sticky-notes）会取不到，整个便签栏静默不加载。
    id: PKG_NAME,
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
          name: PKG_NAME,
          inject: [],
          apply: function () {
            console.warn('[dsh-sticky-notes] 已跳过：react 模块缺失')
          },
        }
        return module.exports
      }

      var h = React.createElement
      var useCallback = React.useCallback
      var memo = typeof React.memo === 'function' ? React.memo : function (component) { return component }
      var useEffect = React.useEffect
      var useMemo = React.useMemo
      var useRef = React.useRef
      var useState = React.useState

      // ---------------------------------------------------------------- 数据

      // 便签内容与面板开合分两个 key 存：内容要在多标签页之间同步，
      // 开合状态只属于当前页，混在一个 key 里会让两个标签页互相覆盖、来回写。
      var STORAGE_KEY = 'dsh-sticky-notes:v1'
      var OPEN_KEY = 'dsh-sticky-notes:open'
      var DRAFT_KEY = 'dsh-sticky-notes:draft'
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
          // 写下这条便签时所处的会话：老数据没有这个字段，归到「全部」里，不强制迁移。
          sessionId: typeof raw.sessionId === 'string' && raw.sessionId ? raw.sessionId : null,
          createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : now,
          updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : now,
          // 手动排序位。老数据用 -updatedAt，正好等价于以前「最近改动在前」。
          order:
            typeof raw.order === 'number' && isFinite(raw.order)
              ? raw.order
              : -(typeof raw.updatedAt === 'number' ? raw.updatedAt : now),
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

      /** 写成功返回 true：调用方要据此把「已保存」改成「保存失败」，不能骗用户。 */
      function writeNotes(notes) {
        try {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ notes: notes }))
          return true
        } catch (error) {
          console.warn('[dsh-sticky-notes] 便签保存失败（可能是存储空间已满）：', error)
          return false
        }
      }

      function writeOpen(open) {
        try {
          window.localStorage.setItem(OPEN_KEY, open ? '1' : '0')
        } catch (error) {
          // 开合状态存不下不影响便签本身，忽略。
        }
      }

      // 还没按「记下」的草稿也存一份：刷新、重装插件、手滑关页面都不该丢半句话。
      function readDraft() {
        try {
          var text = window.localStorage.getItem(DRAFT_KEY)
          return typeof text === 'string' ? text : ''
        } catch (error) {
          return ''
        }
      }

      function writeDraft(text) {
        try {
          if (!text) window.localStorage.removeItem(DRAFT_KEY)
          else window.localStorage.setItem(DRAFT_KEY, text)
        } catch (error) {
          // 草稿存不下不影响主流程（便签本身已经有自己的落盘通道）。
        }
      }

      function sortNotes(notes) {
        return notes.slice().sort(function (a, b) {
          // 置顶的永远在上；组内按手动顺序，没排过的（老数据）自然按时间倒序。
          if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1
          if (a.order !== b.order) return a.order - b.order
          return b.updatedAt - a.updatedAt
        })
      }

      // ------------------------------------------------------------ 备份与恢复
      //
      // 备份必须是「可还原」的格式，所以用 JSON 保留全部字段；Markdown 导出只负责给人看。
      var BACKUP_FORMAT = 'dsh-sticky-notes-backup'

      function backupPayload(notes) {
        return JSON.stringify({ format: BACKUP_FORMAT, version: 1, exportedAt: Date.now(), notes: notes }, null, 2)
      }

      /** 认不出备份就返回 null（调用方据此提示，绝不半途改数据）。 */
      function parseBackup(text) {
        var parsed
        try {
          parsed = JSON.parse(String(text == null ? '' : text))
        } catch (error) {
          return null
        }
        if (!parsed || typeof parsed !== 'object') return null
        var list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.notes) ? parsed.notes : null
        if (!list) return null
        var notes = []
        for (var i = 0; i < list.length; i += 1) {
          var note = normalizeNote(list[i])
          if (note) notes.push(note)
        }
        return notes
      }

      /** 按 id 合并：同 id 取 updatedAt 较新的；不静默覆盖，返回新增/更新条数。 */
      function mergeNotes(current, incoming) {
        var byId = {}
        var order = []
        var i
        for (i = 0; i < current.length; i += 1) {
          byId[current[i].id] = current[i]
          order.push(current[i].id)
        }
        var added = 0
        var updated = 0
        for (i = 0; i < incoming.length; i += 1) {
          var note = incoming[i]
          var existing = byId[note.id]
          if (!existing) {
            byId[note.id] = note
            order.push(note.id)
            added += 1
            continue
          }
          if ((note.updatedAt || 0) > (existing.updatedAt || 0)) {
            byId[note.id] = note
            updated += 1
          }
        }
        var merged = []
        for (i = 0; i < order.length; i += 1) {
          var item = byId[order[i]]
          if (item) merged.push(item)
        }
        return { notes: sortNotes(merged), added: added, updated: updated }
      }

      /** 导出文件名：sticky-notes-20261104-1936.md / .json */
      function stampFilename(extension) {
        var stamp = new Date()
        return (
          'sticky-notes-' +
          stamp.getFullYear() +
          pad2(stamp.getMonth() + 1) +
          pad2(stamp.getDate()) +
          '-' +
          pad2(stamp.getHours()) +
          pad2(stamp.getMinutes()) +
          extension
        )
      }

      function downloadText(filename, text, mime) {
        try {
          var blob = new Blob([text], { type: mime })
          var url = URL.createObjectURL(blob)
          var link = document.createElement('a')
          link.href = url
          link.download = filename
          document.body.appendChild(link)
          link.click()
          window.setTimeout(function () {
            link.remove()
            URL.revokeObjectURL(url)
          }, 0)
          return true
        } catch (error) {
          console.warn('[dsh-sticky-notes] 下载失败：', error)
          return false
        }
      }

      // ------------------------------------------------------------ 本机埋点
      //
      // 只落在 localStorage，不上报。导出 Markdown 时附在末尾，方便用一周后
      // 拿真实数据决定下一步优化顺序（而不是靠直觉）。
      var METRICS_KEY = 'dsh-sticky-notes:metrics:v1'
      var METRIC_KEYS = ['open', 'create', 'edit', 'delete', 'undo', 'pin', 'archive', 'unarchive', 'export', 'search', 'import']
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
        import: '导入备份',
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
        'menu.more': '更多操作',
        'menu.resort': '重排：按最近改动',
        'menu.backup': '导出备份（JSON）',
        'menu.restore': '从备份恢复…',
        'toast.imported': '已导入',
        'toast.updated': '更新',
        'toast.backedUp': '备份已导出',
        'toast.copied': '已复制这条便签',
        'toast.copyFailed': '复制失败，请手动选择文本',
        'toast.importFailed': '不是本插件的备份文件',
        'toast.importEmpty': '备份文件里没有便签',
        close: '收起便签栏',
        'close.esc': '收起便签栏（Esc）',
        'composer.placeholder': '写下此刻的想法…（Ctrl+Enter 记下）',
        'composer.aria': '新便签内容',
        saving: '保存中…',
        saved: '已自动保存到本机',
        'save.failed': '保存失败，请先导出',
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
        'note.edit': '点一下编辑',
        'note.copy': '复制这条便签',
        'note.reorder': '拖动排序（键盘可用 ↑ ↓）',
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
        'filter.session': '本会话',
        'filter.archived': '已归档',
        'empty.session': '这个会话还没有便签',
        'empty.session.sub': '在这里记下的便签会自动归到本会话。',
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
        'metric.import': '导入备份',
      }

      var EN = {
        name: 'Notes',
        'tab.title': 'Notes (Alt+Shift+N)',
        'tab.open': 'Open notes',
        'sub.empty': 'Jot something',
        unit: 'notes',
        export: 'Export as Markdown',
        'menu.more': 'More actions',
        'menu.resort': 'Re-sort: by last edited',
        'menu.backup': 'Export backup (JSON)',
        'menu.restore': 'Restore from backup…',
        'toast.imported': 'Imported',
        'toast.updated': 'updated',
        'toast.backedUp': 'Backup exported',
        'toast.copied': 'Note copied',
        'toast.copyFailed': "Couldn't copy — select the text manually",
        'toast.importFailed': "This isn't a notes backup file",
        'toast.importEmpty': 'That backup has no notes',
        close: 'Collapse notes',
        'close.esc': 'Collapse notes (Esc)',
        'composer.placeholder': 'Jot something… (Ctrl+Enter to save)',
        'composer.aria': 'New note',
        saving: 'Saving…',
        saved: 'Saved locally',
        'save.failed': "Couldn't save — export first",
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
        'note.edit': 'Click to edit',
        'note.copy': 'Copy this note',
        'note.reorder': 'Drag to reorder (or ↑ ↓)',
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
        'filter.session': 'This session',
        'filter.archived': 'Archived',
        'empty.session': 'No notes in this session yet',
        'empty.session.sub': 'Notes you write here are tagged with this session.',
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
        'metric.import': 'Backups restored',
      }

      var dicts = { zh: ZH, en: EN }

      function fallbackT(key) {
        return Object.prototype.hasOwnProperty.call(ZH, key) ? ZH[key] : key
      }

      // 把 locale 服务包成「永不抛错」的 t：拿不到、绑定失败、查不到键，都退回内置中文。
      function wrapT(bound) {
        return function (key) {
          try {
            var value = bound(key)
            if (typeof value === 'string' && value) return value
          } catch (error) {
            // 忽略：查不到键或服务异常都走兜底
          }
          return fallbackT(key)
        }
      }

      // 惰性取 locale 服务：用 ctx.get 探测（静态插件里 ctx.locale 是服务简写，
      // 但把 'locale' 写进 inject 会让「服务没就绪」直接卡住整个 apply，得不偿失）。
      function localeServiceOf(ctx) {
        try {
          if (ctx && typeof ctx.get === 'function') {
            var service = ctx.get('locale')
            if (service) return service
          }
        } catch (error) {
          // 探测失败就继续走简写
        }
        try {
          return ctx && ctx.locale ? ctx.locale : null
        } catch (error) {
          return null
        }
      }

      // 注册字典。DSH 的 locale 服务有两种重载（一次传全部语言 / 一次一种语言），
      // 不同版本对「是否必须覆盖全部内置语言」要求不同：先试整体，失败再逐语言，
      // 任一成功即可，全都失败也不影响插件本体。
      function registerLocale(locale) {
        if (!locale || typeof locale.register !== 'function') return
        try {
          locale.register(NS, dicts)
          return
        } catch (error) {
          // 整体注册不被接受时，退回逐语言注册
        }
        try {
          locale.register(NS, 'zh', ZH)
        } catch (error) {}
        try {
          locale.register(NS, 'en', EN)
        } catch (error) {}
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

      // 一键复制：把这条便签原样放进系统剪贴板（常用来贴到别处或对话输入框）。
      // 拖动把手：两列小圆点（竖向抓握感的通用符号）。
      function IconGrip(size) {
        return pick('IconReOrderDotsVerticalRegular', function (s) {
          return svg(
            [
              h('path', { key: 'a', d: 'M10 6h.01M14 6h.01M10 12h.01M14 12h.01M10 18h.01M14 18h.01' }),
            ],
            s,
          )
        }, size)
      }

      function IconCopy(size) {
        return pick('IconCopyOutlineRegular', function (s) {
          return svg(
            [
              h('path', { key: 'a', d: 'M9 9h9.5v11.5H9z' }),
              h('path', { key: 'b', d: 'M15 9V5.5H5.5V17H9' }),
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

      function IconUpload(size) {
        return pick('IconArrowUploadOutlineRegular', function (s) {
          return svg(
            [
              h('path', { key: 'a', d: 'M12 20.5V10' }),
              h('path', { key: 'b', d: 'M8 13.5l4-4 4 4' }),
              h('path', { key: 'c', d: 'M4.5 4.5h15' }),
            ],
            s,
          )
        }, size)
      }

      // 「更多」三点：备份与恢复这类低频操作收进去，头部按钮数量不变。
      function IconMore(size) {
        return pick('IconMoreHorizontalOutlineRegular', function (s) {
          return svg([h('path', { key: 'a', d: 'M6 12h.01M12 12h.01M18 12h.01' })], s)
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

      // ------------------------------------------------------------ 当前会话
      //
      // 「当前会话」只能从 slot 的标准 kit 里读：ui-layout 自己的 DocumentTitle 也是这么拿的
      // （state.byId 里 retainedBy.mainView > 0 的那条就是主视图当前选中的会话）。
      // 拿不到 kit 就返回 null —— 便签栏照常工作，只是不出现「本会话」这个视图。
      function selectActiveSessionId(state) {
        if (!state || !state.byId) return null
        var rows = state.byId
        for (var id in rows) {
          if (!Object.prototype.hasOwnProperty.call(rows, id)) continue
          var row = rows[id]
          if (!row) continue
          var retained = row.retainedBy
          if (retained && retained.mainView > 0) return row.id || id
        }
        return null
      }

      /**
       * 两个分支都只占一个 hook 槽位，保证 hook 顺序稳定：
       * 有 kit 时用它的 selector hook（会订阅、切会话会重渲染），没有时退回一个常量 state。
       */
      function useActiveSessionId(props) {
        var source = props && typeof props.useSessions === 'function' ? props.useSessions : null
        if (source) {
          try {
            var id = source(selectActiveSessionId)
            return typeof id === 'string' && id ? id : null
          } catch (error) {
            return null
          }
        }
        var fallback = useState(null)
        return fallback[0]
      }

      // ------------------------------------------------------------ 搜索高亮
      //
      // textarea 里画不了 <mark>，所以搜索时正文切成「只读 + 高亮」渲染：
      // 命中段单独包 <mark>，其余按普通文本节点渲染。
      function escapeRegExp(text) {
        return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      }

      function highlightSegments(text, query) {
        var source = String(text == null ? '' : text)
        var keyword = String(query || '').trim()
        if (!keyword) return [source]
        var parts = source.split(new RegExp('(' + escapeRegExp(keyword) + ')', 'gi'))
        var out = []
        for (var i = 0; i < parts.length; i += 1) {
          if (!parts[i]) continue
          if (i % 2 === 1) out.push(h('mark', { key: 'm' + i, className: 'dsn-mark' }, parts[i]))
          else out.push(parts[i])
        }
        return out
      }

      // ---------------------------------------------------------------- 手动排序
      //
      // 每条便签有一个 order（升序 = 从上到下）。新建取 min-1（落在最上面），
      // 老数据没有 order 时用 -updatedAt，正好等价于以前「最近改动在前」的行为。
      function nextOrder(notes) {
        var min = null
        for (var i = 0; i < notes.length; i += 1) {
          var value = notes[i].order
          if (typeof value === 'number' && isFinite(value) && (min === null || value < min)) min = value
        }
        return min === null ? 0 : min - 1
      }

      /** 按给定顺序整体重编号（步进 10）：拖动和「按时间重排」共用。 */
      function renumber(order) {
        var result = []
        for (var i = 0; i < order.length; i += 1) {
          var note = order[i]
          result.push({
            id: note.id,
            text: note.text,
            color: note.color,
            pinned: note.pinned,
            archived: note.archived,
            archivedAt: note.archivedAt,
            sessionId: note.sessionId,
            createdAt: note.createdAt,
            updatedAt: note.updatedAt,
            order: i * 10,
          })
        }
        return result
      }

      /**
       * 把 fromId 挪到 toId 前面（after=false）或后面（after=true），整份重编号。
       * 拖动一次写一次、O(n)，换来顺序稳定、不用处理小数精度。
       */
      function reorderNotes(notes, fromId, toId, after) {
        var ordered = sortNotes(notes)
        var from = -1
        var to = -1
        for (var i = 0; i < ordered.length; i += 1) {
          if (ordered[i].id === fromId) from = i
          if (ordered[i].id === toId) to = i
        }
        if (from === -1 || to === -1 || from === to) return null
        var list = ordered.slice()
        var moved = list.splice(from, 1)[0]
        var insertAt = from < to ? to - 1 : to
        if (after) insertAt += 1
        if (insertAt < 0) insertAt = 0
        if (insertAt > list.length) insertAt = list.length
        list.splice(insertAt, 0, moved)
        return renumber(list)
      }

      /** 放弃手动顺序，按「最近改动」重排（置顶组仍在上面）。 */
      function resortByTime(notes) {
        var ordered = notes.slice().sort(function (a, b) {
          if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1
          return b.updatedAt - a.updatedAt
        })
        return renumber(ordered)
      }

      // ---------------------------------------------------------------- 卡片

      function NoteCard(props) {
        var note = props.note
        var tick = props.tick
        var t = props.t
        var timeLabels = props.timeLabels
        var onChange = props.onChange
        var onCommit = props.onCommit
        var onRemove = props.onRemove
        var onCopy = props.onCopy
        var onCycleColor = props.onCycleColor
        var onTogglePin = props.onTogglePin
        var onArchive = props.onArchive
        var onUnarchive = props.onUnarchive
        var onDragStart = props.onDragStart
        var onDrop = props.onDrop
        var onMoveBy = props.onMoveBy

        var archived = note.archived === true
        var query = props.query || ''
        var editing = props.editing === true
        var onStartEdit = props.onStartEdit
        // 搜索时把正文切成「只读 + 高亮」：textarea 里画不了 <mark>。
        // 点一下这一条就切回可编辑（只有它，其它仍是只读），不打断「正在找什么」。
        var readingOnly = query.trim().length > 0 && !editing

        return h(
          'article',
          {
            className:
              'dsn-note dsn-c-' + note.color + (note.pinned && !archived ? ' is-pinned' : '') + (archived ? ' is-archived' : ''),
            // 拖动时不做 React 状态更新：高亮/半透明直接改 DOM class，
            // 松手才提交一次顺序。这样拖 500 条也不会因为 rerender 掉帧。
            onDragOver: function (event) {
              event.preventDefault()
              var el = event.currentTarget
              if (el && el.classList) el.classList.add('is-drop-target')
            },
            onDragLeave: function (event) {
              var el = event.currentTarget
              if (el && el.classList) el.classList.remove('is-drop-target')
            },
            onDrop: function (event) {
              event.preventDefault()
              var el = event.currentTarget
              if (el && el.classList) el.classList.remove('is-drop-target')
              var after = false
              if (el && typeof el.getBoundingClientRect === 'function' && typeof event.clientY === 'number') {
                var rect = el.getBoundingClientRect()
                after = event.clientY > rect.top + rect.height / 2
              }
              if (typeof onDrop === 'function') onDrop(note.id, after)
            },
          },
          // 拖动把手：贴着卡片左边缘（原来那条色条的位置），hover / 键盘聚焦时才显现。
          h(
            'button',
            {
              type: 'button',
              className: 'dsn-grip',
              draggable: true,
              title: t('note.reorder'),
              'aria-label': t('note.reorder'),
              onDragStart: function (event) {
                if (event && event.dataTransfer) {
                  try {
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('text/plain', note.id)
                  } catch (error) {
                    /* 某些浏览器限制 dataTransfer 写入，拖动本身不受影响 */
                  }
                }
                var el = event && event.currentTarget
                var card = el && el.parentNode
                if (card && card.classList) card.classList.add('is-dragging')
                if (typeof onDragStart === 'function') onDragStart(note.id)
              },
              onDragEnd: function (event) {
                var el = event && event.currentTarget
                var card = el && el.parentNode
                if (card && card.classList) card.classList.remove('is-dragging')
              },
              // 键盘等价操作：把手聚焦后按 ↑/↓ 移动一格，不逼着用户用鼠标。
              onKeyDown: function (event) {
                if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
                event.preventDefault()
                if (typeof onMoveBy === 'function') onMoveBy(note.id, event.key === 'ArrowUp' ? -1 : 1)
              },
            },
            IconGrip(10),
          ),
          readingOnly
            ? h(
                'div',
                {
                  className: 'dsn-note-view',
                  role: archived ? undefined : 'button',
                  tabIndex: archived ? undefined : 0,
                  title: archived ? undefined : t('note.edit'),
                  'aria-label': t('note.aria'),
                  onClick: archived
                    ? undefined
                    : function () {
                        if (typeof onStartEdit === 'function') onStartEdit(note.id)
                      },
                  onKeyDown: archived
                    ? undefined
                    : function (event) {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          if (typeof onStartEdit === 'function') onStartEdit(note.id)
                        }
                      },
                },
                highlightSegments(note.text, query),
              )
            : h(AutoTextarea, {
                className: 'dsn-note-input',
                value: note.text,
                rows: 2,
                spellCheck: false,
                // 从「只读高亮」点进来的这一条，挂载即聚焦，落点就是刚才点的地方。
                autoFocus: editing,
                placeholder: t('note.placeholder'),
                'aria-label': t('note.aria'),
                readOnly: archived,
                onChange: function (event) {
                  onChange(note.id, event.target.value)
                },
                onBlur: function () {
                  if (typeof onCommit === 'function') onCommit(note.id)
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
            // 复制：平时隐起来，hover / 键盘聚焦到这张卡片时才浮现，静态列表不加视觉噪声。
            h(
              'button',
              {
                type: 'button',
                className: 'dsn-icon-btn dsn-copy',
                title: t('note.copy'),
                'aria-label': t('note.copy'),
                onClick: function () {
                  if (typeof onCopy === 'function') onCopy(note.id)
                },
              },
              IconCopy(14),
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

      // 一张卡片要构造 textarea + 时间 + 5 个按钮，整列表重渲染时最贵的就是它。
      // memo 住之后：打字只有正在编辑的那张重渲染，其余按 props 浅比较跳过。
      // 前提是父组件传下来的 note / t / timeLabels / 回调引用保持稳定（见主组件里的 useMemo/useCallback）。
      var NoteCardMemo = memo(NoteCard)

      // ---------------------------------------------------------------- 主组件

      function StickyNotesOverlay(props) {
        var locale = props && props.locale ? props.locale : null
        // 当前会话：来自 slot 的标准 kit；拿不到就是 null（不出现「本会话」视图）。
        var activeSessionId = useActiveSessionId(props)
        var [store, setStore] = useState(readStore)
        var [draft, setDraft] = useState(readDraft)
        var [tick, setTick] = useState(Date.now())
        var [dirty, setDirty] = useState(false)
        // 上一次落盘是否失败（存储满、被禁用）：失败时不能继续显示「已保存」。
        var [saveFailed, setSaveFailed] = useState(false)
        var [query, setQuery] = useState('')
        // 搜索态下点中某一条：只把这一条切回可编辑，其余仍是只读高亮。
        var [editingId, setEditingId] = useState(null)
        // 'all' 或 'archived'：归档视图切换。
        var [view, setView] = useState('all')
        // 删除后 5 秒内可撤销：{ note } 或 null。
        var [undoState, setUndoState] = useState(null)
        // 备份菜单（低频操作收进「更多」，头部按钮数量不变）。
        var [menuOpen, setMenuOpen] = useState(false)
        // 左列右边界：便签栏贴着它展开，不压住会话列表。
        var [leftInset, setLeftInset] = useState(measureSidebarLeft)
        var saveTimer = useRef(0)
        var undoTimer = useRef(0)
        var panelRef = useRef(null)
        var tabRef = useRef(null)
        var menuRef = useRef(null)
        var menuBtnRef = useRef(null)
        var fileRef = useRef(null)
        // 拖动排序的源 id：拖动过程中只改这个 ref，不触发整列表重渲染。
        var dragSourceRef = useRef(null)
        var searchRef = useRef(null)
        // 埋点去抖：同一条便签一次会话里只记一次「编辑」，搜索一次会话只记一次。
        var editedInSession = useRef({})
        // 这条便签自上次失焦后有没有被真的改过：只有改过才更新排序时间。
        var touchedSinceFocus = useRef({})
        var searchRecorded = useRef(false)
        // 最新一份状态，供「刷新/卸载前补写」这类拿不到闭包的路径读取。
        var latestStore = useRef(store)
        // 语言切换时重渲染一次，让 t() 重新绑定当前语言。
        var [localeTick, setLocaleTick] = useState(0)

        // 订阅语言切换；t 在每次渲染重新绑定，保证切换后立刻生效。
        useEffect(
          function () {
            if (!locale || typeof locale.subscribe !== 'function') return undefined
            try {
              var unsubscribe = locale.subscribe(function () {
                setLocaleTick(function (n) {
                  return n + 1
                })
              })
              if (typeof unsubscribe === 'function') return unsubscribe
            } catch (error) {
              // 订阅失败只影响「切换语言要刷新」，不影响渲染
            }
            return undefined
          },
          [locale],
        )

        // t / timeLabels 要 memo 住：它们是 memo(NoteCard) 的 props，
        // 每次渲染换个新函数/新对象就会让所有卡片白渲染一遍。
        var t = useMemo(
          function () {
            var bound = fallbackT
            if (locale && typeof locale.bind === 'function') {
              try {
                var boundT = locale.bind(NS)
                if (typeof boundT === 'function') bound = wrapT(boundT)
              } catch (error) {
                console.warn('[dsh-sticky-notes] locale.bind 失败，改用内置中文：', error && error.message)
              }
            }
            return bound
          },
          [locale, localeTick],
        )

        var timeLabels = useMemo(
          function () {
            return {
              justNow: t('time.justNow'),
              minutesAgo: t('time.minutesAgo'),
              hoursAgo: t('time.hoursAgo'),
            }
          },
          [t],
        )

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

        // 会话视图：只看「在当前会话里写下的便签」。老便签没有 sessionId，不会出现在这里。
        var sessionNotes = useMemo(
          function () {
            if (!activeSessionId) return []
            return activeNotes.filter(function (note) {
              return note.sessionId === activeSessionId
            })
          },
          [activeNotes, activeSessionId],
        )

        var baseList = view === 'archived' ? archivedNotes : view === 'session' ? sessionNotes : activeNotes
        // 搜索时列表覆盖全部（含归档），标签同步高亮「全部」，否则标签和结果对不上。
        var activeTab = query.trim() ? 'all' : view
        var filteredNotes = useMemo(
          function () {
            var keyword = query.trim().toLowerCase()
            if (!keyword) return baseList
            // 有搜索词就搜全部（含已归档）：便签最痛的失败是「找不到」，
            // 「它不在当前视图里」不该成为找不到的理由。点过滤标签会清掉搜索词，语义不打架。
            return notes.filter(function (note) {
              return note.text.toLowerCase().indexOf(keyword) !== -1
            })
          },
          [baseList, query, notes],
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
              var ok = writeNotes(latestStore.current.notes)
              setDirty(false)
              setSaveFailed(!ok)
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

        // 草稿实时落盘：刷新、重装插件、手滑关页面都不丢还没按「记下」的半句话。
        useEffect(
          function () {
            writeDraft(draft)
          },
          [draft],
        )

        // 立刻落盘：刷新、关页面、插件卸载时不能丢最后几个字。
        useEffect(function () {
          function flushNow() {
            if (saveTimer.current) {
              window.clearTimeout(saveTimer.current)
              saveTimer.current = 0
            }
            if (!writeNotes(latestStore.current.notes)) setSaveFailed(true)
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

        var close = useCallback(function (options) {
          // 收起后把焦点还给左边缘的「便签」标签：键盘用户不会掉到页面开头。
          // 点面板外面收起时不还焦点，否则会抢走用户刚点的那一处。
          var restoreFocus = !options || options.restoreFocus !== false
          setQuery('')
          setView('all')
          setMenuOpen(false)
          setStore(function (prev) {
            return prev.open ? { notes: prev.notes, open: false } : prev
          })
          if (restoreFocus) {
            window.setTimeout(function () {
              var node = tabRef.current
              if (node && typeof node.focus === 'function') node.focus()
            }, 0)
          }
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
                // 菜单开着时，Esc 先关菜单；再按一次才清搜索 / 收面板。
                if (menuOpen) {
                  setMenuOpen(false)
                  return
                }
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
          [open, close, query, menuOpen],
        )

        // 点面板外面收起。没有全屏遮罩，所以点一下别处既能让面板消失、又不会拦掉那次点击。
        useEffect(
          function () {
            if (!open || typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
            function onPointerDown(event) {
              var target = event.target
              // 菜单是面板里的一小块浮层：点它和触发器以外的地方就收起菜单。
              if (menuOpen) {
                var menu = menuRef.current
                var trigger = menuBtnRef.current
                var inMenu = menu && target && typeof menu.contains === 'function' && menu.contains(target)
                var inTrigger = trigger && target && typeof trigger.contains === 'function' && trigger.contains(target)
                if (!inMenu && !inTrigger) setMenuOpen(false)
              }
              var panel = panelRef.current
              if (!panel) return
              if (target && typeof panel.contains === 'function' && panel.contains(target)) return
              close({ restoreFocus: false })
            }
            document.addEventListener('pointerdown', onPointerDown, true)
            return function () {
              document.removeEventListener('pointerdown', onPointerDown, true)
            }
          },
          [open, close, menuOpen],
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
              // 记下这条便签时所在的会话：之后可以只看「本会话」。
              sessionId: activeSessionId,
              createdAt: now,
              updatedAt: now,
              // 新便签永远落在最上面，不管之前怎么手动排过。
              order: nextOrder(prev.notes),
            }
            return { notes: [note].concat(prev.notes).slice(0, MAX_NOTES), open: true }
          })
          setDraft('')
          setTick(now)
          recordMetric('create')
        }, [activeSessionId])

        // 搜索词一变，「哪条在编辑」就复位：换了一次搜索还停在编辑态会很怪。
        useEffect(
          function () {
            setEditingId(null)
          },
          [query],
        )

        var startEdit = useCallback(function (id) {
          setEditingId(id)
        }, [])

        // 下面这些回调都会作为 memo(NoteCard) 的 props：引用必须稳定，否则 memo 全部失效。
        // 所以统一 useCallback([])，并且**不闭包 store** —— 需要「当前列表」时读 latestStore。
        function findIn(list, id) {
          for (var i = 0; i < list.length; i += 1) {
            if (list[i].id === id) return list[i]
          }
          return null
        }

        var updateNote = useCallback(function (id, text) {
          setStore(function (prev) {
            var changed = false
            var next = prev.notes.map(function (note) {
              if (note.id !== id) return note
              if (note.text === text) return note
              changed = true
              // 注意：这里不刷 updatedAt。列表按 updatedAt 排序，如果每敲一个字就刷，
              // 正在编辑的卡片会立刻跳到列表最顶部，滚动位置跟着跳——打字体验直接崩。
              // 「最近改动」留到失焦时由 commitNote 更新。
              return { id: note.id, text: text, color: note.color, pinned: note.pinned, archived: note.archived, archivedAt: note.archivedAt, sessionId: note.sessionId, order: note.order, createdAt: note.createdAt, updatedAt: note.updatedAt }
            })
            return changed ? { notes: next, open: prev.open } : prev
          })
          touchedSinceFocus.current[id] = true
          if (editedInSession.current[id] !== true) {
            editedInSession.current[id] = true
            recordMetric('edit')
          }
        }, [])

        // 编辑结束（失焦）才把这条便签标记成「刚改过」。没真改动过的点击不算。
        var commitNote = useCallback(function (id) {
          if (touchedSinceFocus.current[id] !== true) return
          delete touchedSinceFocus.current[id]
          var target = findIn(latestStore.current.notes, id)
          if (!target || target.archived === true) return
          var now = Date.now()
          setStore(function (prev) {
            var next = prev.notes.map(function (note) {
              if (note.id !== id) return note
              return { id: note.id, text: note.text, color: note.color, pinned: note.pinned, archived: note.archived, archivedAt: note.archivedAt, sessionId: note.sessionId, order: note.order, createdAt: note.createdAt, updatedAt: now }
            })
            return { notes: next, open: prev.open }
          })
        }, [])

        var cycleColor = useCallback(function (id) {
          setStore(function (prev) {
            var next = prev.notes.map(function (note) {
              if (note.id !== id) return note
              var index = COLOR_IDS.indexOf(note.color)
              var color = COLOR_IDS[(index + 1) % COLOR_IDS.length]
              return { id: note.id, text: note.text, color: color, pinned: note.pinned, archived: note.archived, archivedAt: note.archivedAt, sessionId: note.sessionId, order: note.order, createdAt: note.createdAt, updatedAt: note.updatedAt }
            })
            return { notes: next, open: prev.open }
          })
        }, [])

        var togglePin = useCallback(function (id) {
          if (!findIn(latestStore.current.notes, id)) return
          setStore(function (prev) {
            var next = prev.notes.map(function (note) {
              if (note.id !== id) return note
              return { id: note.id, text: note.text, color: note.color, pinned: !note.pinned, archived: note.archived, archivedAt: note.archivedAt, sessionId: note.sessionId, order: note.order, createdAt: note.createdAt, updatedAt: note.updatedAt }
            })
            return { notes: next, open: prev.open }
          })
          recordMetric('pin')
        }, [])

        var archiveNote = useCallback(function (id) {
          if (!findIn(latestStore.current.notes, id)) return
          var now = Date.now()
          setStore(function (prev) {
            var next = prev.notes.map(function (note) {
              if (note.id !== id) return note
              return { id: note.id, text: note.text, color: note.color, pinned: note.pinned, archived: true, archivedAt: now, sessionId: note.sessionId, order: note.order, createdAt: note.createdAt, updatedAt: note.updatedAt }
            })
            return { notes: next, open: prev.open }
          })
          recordMetric('archive')
        }, [])

        var unarchiveNote = useCallback(function (id) {
          if (!findIn(latestStore.current.notes, id)) return
          setStore(function (prev) {
            var next = prev.notes.map(function (note) {
              if (note.id !== id) return note
              return { id: note.id, text: note.text, color: note.color, pinned: note.pinned, archived: false, archivedAt: 0, sessionId: note.sessionId, order: note.order, createdAt: note.createdAt, updatedAt: note.updatedAt }
            })
            return { notes: next, open: prev.open }
          })
          recordMetric('unarchive')
        }, [])

        // 拖动排序：拖起时只记一个 ref，松手才提交一次顺序（拖动过程零 re-render）。
        var startDrag = useCallback(function (id) {
          dragSourceRef.current = id
        }, [])

        var dropOn = useCallback(function (id, after) {
          var from = dragSourceRef.current
          dragSourceRef.current = null
          if (!from || from === id) return
          setStore(function (prev) {
            var next = reorderNotes(prev.notes, from, id, after === true)
            return next ? { notes: next, open: prev.open } : prev
          })
        }, [])

        // 键盘等价：把手聚焦后 ↑/↓ 移动一格。
        var moveBy = useCallback(function (id, delta) {
          setStore(function (prev) {
            var ordered = sortNotes(prev.notes)
            var index = -1
            for (var i = 0; i < ordered.length; i += 1) {
              if (ordered[i].id === id) index = i
            }
            if (index === -1) return prev
            var target = ordered[index + delta]
            if (!target) return prev
            var next = reorderNotes(prev.notes, id, target.id, delta > 0)
            return next ? { notes: next, open: prev.open } : prev
          })
        }, [])

        // 底部提示条只有一个通道，三种文案：删除了 / 导入了 / 出错了。
        function toastText(pending) {
          if (!pending) return ''
          if (pending.kind === 'import') {
            var text = t('toast.imported') + ' ' + pending.added + ' ' + t('unit')
            if (pending.updated) text += ' · ' + t('toast.updated') + ' ' + pending.updated + ' ' + t('unit')
            return text
          }
          if (pending.kind === 'delete') return t('toast.deleted')
          return pending.text || ''
        }

        function showToast(next, ms) {
          setUndoState(next)
          if (undoTimer.current) window.clearTimeout(undoTimer.current)
          undoTimer.current = window.setTimeout(function () {
            undoTimer.current = 0
            setUndoState(null)
          }, ms || UNDO_MS)
        }

        // 删除立即生效，但给 5 秒撤销窗口：比「再点一次确认」更不打断思路，也更可逆。
        var removeNote = useCallback(function (id) {
          var target = findIn(latestStore.current.notes, id)
          if (!target) return
          setStore(function (prev) {
            return { notes: prev.notes.filter(function (note) { return note.id !== id }), open: prev.open }
          })
          showToast({ kind: 'delete', note: target }, UNDO_MS)
          recordMetric('delete')
        }, [])

        // 一键复制：走系统剪贴板；拿不到就明确说失败，让用户手动选文本（不假装成功）。
        var copyNote = useCallback(function (id) {
          var target = findIn(latestStore.current.notes, id)
          if (!target) return
          var text = String(target.text == null ? '' : target.text)
          var done = function (ok) {
            showToast(
              ok ? { kind: 'info', text: t('toast.copied') } : { kind: 'error', text: t('toast.copyFailed') },
              ok ? 2400 : 3200,
            )
          }
          try {
            var clipboard = typeof navigator !== 'undefined' && navigator ? navigator.clipboard : null
            if (clipboard && typeof clipboard.writeText === 'function') {
              Promise.resolve(clipboard.writeText(text)).then(function () {
                done(true)
              }, function () {
                done(false)
              })
              return
            }
          } catch (error) {
            // 落到下面的失败提示
          }
          done(false)
        }, [t])

        function undoAction() {
          var pending = undoState
          if (!pending) return
          if (undoTimer.current) {
            window.clearTimeout(undoTimer.current)
            undoTimer.current = 0
          }
          if (pending.kind === 'import') {
            // 导入的撤销 = 整份换回导入前那一份列表，天然可逆，不用逐条比对。
            var restore = pending.notes
            setStore(function () {
              return { notes: restore, open: true }
            })
            setUndoState(null)
            recordMetric('undo')
            return
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

          downloadText(stampFilename('.md'), lines.join('\n'), 'text/markdown;charset=utf-8')
        }, [store.notes])

        // 放弃手动顺序，整份按「最近改动」重排。
        var resortOrder = function () {
          setStore(function (prev) {
            return { notes: resortByTime(prev.notes), open: prev.open }
          })
        }

        // 备份（JSON）与恢复：备份是可还原的格式，Markdown 只负责给人看。
        var exportBackup = function () {
          if (!store.notes.length) return
          recordMetric('export')
          if (downloadText(stampFilename('.json'), backupPayload(store.notes), 'application/json;charset=utf-8')) {
            showToast({ kind: 'info', text: t('toast.backedUp') }, 4000)
          }
        }

        function importBackup(text) {
          var incoming = parseBackup(text)
          if (!incoming) {
            showToast({ kind: 'error', text: t('toast.importFailed') }, 4000)
            return false
          }
          if (!incoming.length) {
            showToast({ kind: 'error', text: t('toast.importEmpty') }, 4000)
            return false
          }
          var before = store.notes
          var result = mergeNotes(before, incoming)
          setStore(function () {
            return { notes: result.notes.slice(0, MAX_NOTES), open: true }
          })
          showToast({ kind: 'import', notes: before, added: result.added, updated: result.updated }, UNDO_MS)
          recordMetric('import')
          return true
        }

        // 选文件这一步只能异步：file.text() 是 Promise。读失败按「不是备份文件」处理。
        function onFilePick(event) {
          var input = event && event.target
          var file = input && input.files && input.files[0]
          if (!file) return undefined
          // 清空 value：不然连续导同一个文件不会触发 change。
          if (typeof input.value === 'string') input.value = ''
          if (typeof file.text !== 'function') {
            showToast({ kind: 'error', text: t('toast.importFailed') }, 4000)
            return undefined
          }
          return Promise.resolve(file.text()).then(importBackup, function () {
            showToast({ kind: 'error', text: t('toast.importFailed') }, 4000)
            return false
          })
        }

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
            ref: tabRef,
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
                {
                  type: 'button',
                  className: 'dsn-icon-btn dsn-more',
                  title: t('menu.more'),
                  'aria-label': t('menu.more'),
                  'aria-haspopup': 'menu',
                  'aria-expanded': menuOpen ? 'true' : 'false',
                  ref: menuBtnRef,
                  onClick: function () {
                    setMenuOpen(function (prev) {
                      return !prev
                    })
                  },
                },
                IconMore(15),
              ),
              h(
                'button',
                { type: 'button', className: 'dsn-icon-btn', title: t('export'), 'aria-label': t('export'), onClick: exportNotes, disabled: visibleCount === 0 },
                IconDownload(15),
              ),
              h('button', { type: 'button', className: 'dsn-icon-btn', title: t('close.esc'), 'aria-label': t('close'), onClick: close }, IconClose(15)),
            ),
            // 备份与恢复是低频操作：收在「更多」里，头部按钮数量不变。
            menuOpen
              ? h(
                  'div',
                  { className: 'dsn-menu', role: 'menu', 'aria-label': t('menu.more'), ref: menuRef },
                  h(
                    'button',
                    {
                      type: 'button',
                      role: 'menuitem',
                      className: 'dsn-menu-item',
                      onClick: function () {
                        setMenuOpen(false)
                        exportBackup()
                      },
                    },
                    IconDownload(14),
                    h('span', null, t('menu.backup')),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      role: 'menuitem',
                      className: 'dsn-menu-item',
                      onClick: function () {
                        setMenuOpen(false)
                        var input = fileRef.current
                        if (input && typeof input.click === 'function') input.click()
                      },
                    },
                    IconUpload(14),
                    h('span', null, t('menu.restore')),
                  ),
                  // 手动拖乱了怎么办：一键回到「最近改动」顺序。
                  h(
                    'button',
                    {
                      type: 'button',
                      role: 'menuitem',
                      className: 'dsn-menu-item',
                      onClick: function () {
                        setMenuOpen(false)
                        resortOrder()
                      },
                    },
                    IconGrip(14),
                    h('span', null, t('menu.resort')),
                  ),
                )
              : null,
            h('input', {
              className: 'dsn-file',
              type: 'file',
              accept: '.json,application/json',
              tabIndex: -1,
              'aria-hidden': 'true',
              ref: fileRef,
              onChange: onFilePick,
            }),
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
                // 中文/日文输入法正在组词时按 Enter 是「选词」，不能当成「记下」。
                if (event.nativeEvent && event.nativeEvent.isComposing) return
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                  event.preventDefault()
                  addNote(draft)
                }
              },
            }),
            h(
              'div',
              { className: 'dsn-composer-foot' },
              h(
                'span',
                {
                  className: 'dsn-hint' + (saveFailed ? ' is-error' : ''),
                  role: saveFailed ? 'alert' : undefined,
                },
                saveFailed ? t('save.failed') : dirty ? t('saving') : t('saved'),
              ),
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
                { className: 'dsn-filter', role: 'tablist', 'aria-label': t('name') },
                h(
                  'button',
                  {
                    type: 'button',
                    role: 'tab',
                    className: 'dsn-filter-btn' + (activeTab === 'all' ? ' is-active' : ''),
                    'aria-selected': activeTab === 'all' ? 'true' : 'false',
                    onClick: function () {
                      setView('all')
                      setQuery('')
                    },
                  },
                  t('filter.all') + ' ' + activeNotes.length,
                ),
                // 「本会话」只在真拿到会话 id 时才出现：拿不到就当一个纯本地便签栏用。
                activeSessionId
                  ? h(
                      'button',
                      {
                        type: 'button',
                        role: 'tab',
                        className: 'dsn-filter-btn' + (activeTab === 'session' ? ' is-active' : ''),
                        'aria-selected': activeTab === 'session' ? 'true' : 'false',
                        onClick: function () {
                          setView('session')
                          setQuery('')
                        },
                      },
                      t('filter.session') + ' ' + sessionNotes.length,
                    )
                  : null,
                h(
                  'button',
                  {
                    type: 'button',
                    role: 'tab',
                    className: 'dsn-filter-btn' + (activeTab === 'archived' ? ' is-active' : ''),
                    'aria-selected': activeTab === 'archived' ? 'true' : 'false',
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
                  h('div', { className: 'dsn-empty-title' }, query ? t('empty.search') : view === 'archived' ? t('empty.archived') : view === 'session' ? t('empty.session') : t('empty.none')),
                  h('div', { className: 'dsn-empty-sub' }, query ? t('empty.search.sub') : view === 'archived' ? t('empty.archived.sub') : view === 'session' ? t('empty.session.sub') : t('empty.none.sub')),
                )
              : filteredNotes.map(function (note) {
                  return h(NoteCardMemo, {
                    key: note.id,
                    note: note,
                    tick: tick,
                    t: t,
                    timeLabels: timeLabels,
                    query: query,
                    editing: editingId === note.id,
                    onStartEdit: startEdit,
                    onChange: updateNote,
                    onCommit: commitNote,
                    onRemove: removeNote,
                    onCopy: copyNote,
                    onDragStart: startDrag,
                    onDrop: dropOn,
                    onMoveBy: moveBy,
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
                {
                  className: 'dsn-toast' + (undoState.kind === 'error' ? ' is-error' : ''),
                  role: undoState.kind === 'error' ? 'alert' : 'status',
                  'aria-live': undoState.kind === 'error' ? 'assertive' : 'polite',
                },
                h('span', { className: 'dsn-toast-text' }, toastText(undoState)),
                undoState.kind === 'error' || undoState.kind === 'info'
                  ? null
                  : h(
                      'button',
                      { type: 'button', className: 'dsn-toast-undo', onClick: undoAction },
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
        // 原样把 slot 送来的一整套 props（含 useSessions 这类标准 selector hook）转给主组件。
        return h(StickyNotesBoundary, null, h(StickyNotesOverlay, props || {}))
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
        '.dsn-menu{position:absolute;top:46px;right:10px;z-index:3;min-width:186px;padding:4px;border:1px solid var(--dsn-line);border-radius:10px;background:var(--dsn-surface);box-shadow:0 12px 30px rgba(0,0,0,.22);animation:dsn-toast-in .1s ease-out}',
        '.dsn-menu-item{display:flex;align-items:center;gap:8px;width:100%;min-height:32px;padding:5px 9px;border:0;border-radius:7px;background:transparent;color:var(--dsn-fg);font:inherit;font-size:12px;text-align:left;cursor:pointer}',
        '.dsn-menu-item:hover{background:rgba(127,127,127,.14)}',
        '.dsn-menu-item:focus-visible{outline:2px solid var(--dsn-accent);outline-offset:1px}',
        '.dsn-file{display:none}',
        '.dsn-icon-btn{display:grid;place-items:center;width:32px;height:32px;padding:0;border:0;border-radius:9px;background:transparent;color:var(--dsn-fg-2);cursor:pointer;font:inherit;transition:background .12s ease,color .12s ease}',
        '.dsn-icon-btn:hover:not(:disabled){background:rgba(127,127,127,.16);color:var(--dsn-fg)}',
        '.dsn-icon-btn:disabled{opacity:.38;cursor:default}',
        // 复制按钮平时隐形，鼠标进卡片或键盘聚焦时才浮现：静态列表不加视觉噪声。
        '.dsn-copy{opacity:0;transition:opacity .12s ease}',
        '.dsn-note:hover .dsn-copy,.dsn-note:focus-within .dsn-copy,.dsn-copy:focus-visible{opacity:1}',
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
        // 小字不用错误色当文字色：实测浅色主题下 error 色压白底只有 4.50:1，
        // 贴着 AA 线。改成正文色 + 一个错误色圆点（图形元素只需 3:1 语义）。
        '.dsn-hint.is-error{color:var(--dsn-fg);font-weight:600}',
        '.dsn-hint.is-error::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-error-primary,#d84315);margin-right:4px;vertical-align:1px}',
        '.dsn-save{display:inline-flex;align-items:center;gap:5px;min-height:32px;padding:6px 14px;border:0;border-radius:9px;background:var(--dsn-accent);color:var(--dsn-on-accent);font:inherit;font-size:12px;font-weight:650;cursor:pointer;transition:filter .12s ease,transform .12s ease}',
        '.dsn-save:hover:not(:disabled){filter:brightness(.94);transform:translateY(-1px)}',
        '.dsn-save:disabled{opacity:.42;cursor:default;transform:none;filter:none}',
        '.dsn-list{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:2px 14px 16px;display:flex;flex-direction:column;gap:9px;scrollbar-width:thin}',
        '.dsn-list.has-toast{padding-bottom:64px}',
        '.dsn-list::-webkit-scrollbar{width:8px}',
        '.dsn-list::-webkit-scrollbar-thumb{background:rgba(127,127,127,.32);border-radius:4px}',
        '.dsn-note{--dsn-sticky:#f0b13a;position:relative;border:1px solid var(--dsn-line);border-left:3px solid var(--dsn-sticky);border-radius:11px;background:rgba(127,127,127,.08);padding:7px 8px 4px 16px}',
        // 拖动把手：占住左边缘（色条 + 内边距）那块空隙，平时隐形，hover/聚焦才显形。
        '.dsn-grip{position:absolute;left:1px;top:5px;width:22px;height:24px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsn-fg-2);opacity:0;cursor:grab;display:grid;place-items:center;transition:opacity .12s ease,background .12s ease}',
        '.dsn-note:hover .dsn-grip,.dsn-note:focus-within .dsn-grip{opacity:.7}',
        '.dsn-grip:hover{opacity:1;background:rgba(127,127,127,.16)}',
        '.dsn-grip:focus-visible{opacity:1;outline:2px solid var(--dsn-accent);outline-offset:1px}',
        '.dsn-grip:active{cursor:grabbing}',
        '.dsn-note.is-dragging{opacity:.45}',
        '.dsn-note.is-drop-target{box-shadow:inset 0 0 0 1px var(--dsn-accent)}',
        '.dsn-c-amber{--dsn-sticky:#f0b13a}',
        '.dsn-c-sky{--dsn-sticky:#4f9dff}',
        '.dsn-c-mint{--dsn-sticky:#3fbd8b}',
        '.dsn-c-rose{--dsn-sticky:#f4728f}',
        '.dsn-c-violet{--dsn-sticky:#a58bfa}',
        '.dsn-note-input{width:100%;border:0;background:transparent;color:inherit;font:inherit;font-size:13px;line-height:1.55;resize:none;padding:2px 2px 0;overflow:hidden;display:block}',
        '.dsn-note-input:focus{outline:none}',
        '.dsn-note-input::placeholder{color:var(--dsn-fg-2);opacity:.85}',
        '.dsn-note-view{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.55;padding:1px 2px 2px;border-radius:6px;cursor:text}',
        '.dsn-note-view:hover{background:rgba(127,127,127,.07)}',
        '.dsn-note-view:focus-visible{outline:2px solid var(--dsn-accent);outline-offset:1px}',
        '.dsn-mark{background:rgba(127,127,127,.3);color:inherit;font-weight:650;border-radius:3px;padding:0 1px}',
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
        // 错误提示条：改成「面板底 + 错误色边框」，文字用正文色 18.90:1；
        // 之前是错误色实底 + 反色文字，浅色主题实测只有 4.50:1（贴线不合格）。
        '.dsn-toast.is-error{background:var(--dsn-surface);color:var(--dsn-fg);border:1px solid var(--dsw-alias-state-error-primary,#d84315);border-left-width:3px}',
        '.dsn-toast-text{font-size:12px;margin-right:auto}',
        '.dsn-toast-undo{display:inline-flex;align-items:center;gap:4px;min-height:24px;border:0;border-radius:7px;padding:3px 9px;background:transparent;color:inherit;font:inherit;font-size:12px;font-weight:650;cursor:pointer}',
        '.dsn-toast-undo:hover{background:rgba(127,127,127,.24)}',
        '.dsn-toast-undo:focus-visible{outline:2px solid var(--dsn-on-accent);outline-offset:1px}',
        '@keyframes dsn-toast-in{from{transform:translateY(6px);opacity:0}to{transform:none;opacity:1}}',
        '@media (prefers-reduced-motion: reduce){.dsn-panel,.dsn-toast{animation:none}.dsn-tab,.dsn-save,.dsn-dot-btn,.dsn-dot-btn::after{transition:none}}',
      ].join('\n')

      // ---------------------------------------------------------------- 插件

      var name = PKG_NAME
      // 只把 slots 作为硬依赖：locale 是可选增强，用 ctx.get 惰性探测，
      // 免得「语言服务没就绪」把整个插件卡在 waiting（那就一个 slot 都注册不了）。
      var inject = ['slots']

      function apply(ctx) {
        // 注册文案字典：zh 是键集真源，en 对齐，其余语言按 en 回退。
        // 任何一步失败都只影响文案，不影响便签栏本身。
        var locale = localeServiceOf(ctx)
        ctx.effect(
          function () {
            registerLocale(locale)
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
          yield ctx.slots.register({ name: 'shell.overlay', id: 'sticky-notes', order: 860 }, function (slotProps) {
            // slot 会送来一整套标准 kit（useSessions / usePanelInfo / …）：
            // 必须原样转发下去，否则便签栏读不到「当前会话」。
            return h(StickyNotesRoot, Object.assign({}, slotProps || {}, { locale: locale }))
          })
        })
      }

      module.exports = { apply: apply, inject: inject, name: name }
      return module.exports
    },
  })
})()
