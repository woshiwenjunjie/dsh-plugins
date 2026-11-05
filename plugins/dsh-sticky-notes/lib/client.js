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
      // 回顾条：每天挑一条「旧」便签看一眼。只存「今天挑了谁、关没关」，不进便签数据。
      var REVIEW_KEY = 'dsh-sticky-notes:review'
      // 至少两小时没动过才算「旧」；最近三条不参与（刚写过的不需要被回顾）。
      var REVIEW_MIN_IDLE = 2 * 60 * 60 * 1000
      var REVIEW_FRESH_SKIP = 3
      var SAVE_DEBOUNCE_MS = 300
      var MAX_NOTES = 500
      // 便签到这个数量再显示搜索框，少的时候不占地方。
      var SEARCH_THRESHOLD = 6
      // 删除后的撤销窗口。
      var UNDO_MS = 5000

      // 颜色 = 重要程度（2026-11-04 用户拍板）：1 最要紧 → 4 靠后，5「未排」是默认档。
      // 语义是视图层的固定映射，数据里仍然只存原来的颜色字符串，不新增字段、不碰备份格式。
      var PRIORITY_LEVELS = [
        { id: 'rose', level: 1, label: 'priority.1' },
        { id: 'amber', level: 2, label: 'priority.2' },
        { id: 'mint', level: 3, label: 'priority.3' },
        { id: 'sky', level: 4, label: 'priority.4' },
        { id: 'violet', level: 5, label: 'priority.5' },
      ]
      var COLOR_IDS = PRIORITY_LEVELS.map(function (item) {
        return item.id
      })
      // 新便签不再随机取色：默认落在「未排」，系统不替你排优先级。
      var DEFAULT_COLOR = 'violet'

      function levelOf(colorId) {
        for (var i = 0; i < PRIORITY_LEVELS.length; i += 1) {
          if (PRIORITY_LEVELS[i].id === colorId) return PRIORITY_LEVELS[i]
        }
        return PRIORITY_LEVELS[PRIORITY_LEVELS.length - 1]
      }

      /**
       * 档位名（最要紧 / 要紧 / 一般 / 靠后 / 未排）。
       * 颜色不能作为唯一信息通道（WCAG 1.4.1），所以色点、色板、筛选菜单里都同时给数字和文字。
       */
      function priorityName(t, colorId) {
        var level = levelOf(colorId)
        var label = t(level.label)
        return !label || label === level.label ? level.id : label
      }

      /** 「1 最要紧」这种带数字的完整说法：给 aria-label / title / 色板 / 筛选菜单用。 */
      function priorityText(t, colorId) {
        return levelOf(colorId).level + ' ' + priorityName(t, colorId)
      }

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
          color: COLOR_IDS.indexOf(raw.color) === -1 ? DEFAULT_COLOR : raw.color,
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

      // ------------------------------------------------------------ 回顾条
      //
      // 「每天看一眼旧便签」的极简版：不推送、不弹窗，只在打开面板时浮一条。
      // 挑选规则故意保守——非归档、非置顶、有正文、至少两小时没动过，且不在这三条最新里；
      // 同一天只挑一次（打字时不会来回换），关掉就今天不再出现。

      function dayKey(ms) {
        var date = new Date(ms)
        var month = date.getMonth() + 1
        var day = date.getDate()
        return date.getFullYear() + '-' + (month < 10 ? '0' + month : month) + '-' + (day < 10 ? '0' + day : day)
      }

      function readReview() {
        try {
          var raw = window.localStorage.getItem(REVIEW_KEY)
          var parsed = raw ? JSON.parse(raw) : null
          if (!parsed || typeof parsed !== 'object') return null
          return {
            day: typeof parsed.day === 'string' ? parsed.day : '',
            id: typeof parsed.id === 'string' ? parsed.id : '',
            hidden: parsed.hidden === true,
          }
        } catch (error) {
          return null
        }
      }

      function writeReview(review) {
        try {
          window.localStorage.setItem(REVIEW_KEY, JSON.stringify(review))
        } catch (error) {
          // 存不下只影响「今天不再显示」，不影响便签本身，忽略。
        }
      }

      function pickReviewNote(notes, lastId) {
        var ordered = sortNotes(notes)
        var skip = {}
        for (var i = 0; i < ordered.length && i < REVIEW_FRESH_SKIP; i += 1) skip[ordered[i].id] = true
        var cutoff = Date.now() - REVIEW_MIN_IDLE
        var pool = []
        for (var j = 0; j < ordered.length; j += 1) {
          var note = ordered[j]
          if (note.archived === true || note.pinned === true) continue
          if (skip[note.id]) continue
          if (!String(note.text == null ? '' : note.text).trim()) continue
          if (note.updatedAt > cutoff) continue
          pool.push(note)
        }
        if (!pool.length) return null
        var candidates = pool
        if (lastId) {
          var others = pool.filter(function (note) {
            return note.id !== lastId
          })
          if (others.length) candidates = others
        }
        return candidates[Math.floor(Math.random() * candidates.length)]
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

      /** 两份便签列表是否完全一样：用来判断「本页还有没有没落盘的改动」。 */
      function sameNoteList(a, b) {
        return JSON.stringify(a || []) === JSON.stringify(b || [])
      }

      /**
       * 另一页刚写完 notes，而本页也有还没落盘的改动：整份替换会把这页正在打的字冲掉，
       * 所以按 id 判断谁动过，再合并：
       * - 本页动过（和上次落盘快照不同）：保本页；
       * - 本页没动、另一页改过：用另一页的；
       * - 本页没动、另一页删掉：跟着删；
       * - 另一页新增：加进来；本页刚删掉的：不跟着复活。
       * 代价：同一 id 两边同时改是「后落盘的赢」（和原来整份覆盖一致），
       * 本页正在编辑的那条被另一页删掉时，删除要等本页落盘后才生效。
       */
      function mergeIncomingNotes(local, saved, incoming) {
        var localById = {}
        var savedById = {}
        var incomingById = {}
        var merged = []
        var i
        for (i = 0; i < local.length; i += 1) localById[local[i].id] = local[i]
        for (i = 0; i < saved.length; i += 1) savedById[saved[i].id] = saved[i]
        for (i = 0; i < incoming.length; i += 1) incomingById[incoming[i].id] = incoming[i]
        for (i = 0; i < local.length; i += 1) {
          var note = local[i]
          var before = savedById[note.id]
          var dirty = !before || JSON.stringify(before) !== JSON.stringify(note)
          if (dirty) {
            merged.push(note)
            continue
          }
          var theirs = incomingById[note.id]
          if (theirs) merged.push(theirs)
        }
        for (i = 0; i < incoming.length; i += 1) {
          var extra = incoming[i]
          if (localById[extra.id]) continue
          // 本页删掉的（上次落盘时还在、现在没了）不跟着另一页复活。
          if (savedById[extra.id]) continue
          merged.push(extra)
        }
        return merged
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
      var METRIC_KEYS = ['open', 'create', 'edit', 'delete', 'undo', 'pin', 'archive', 'unarchive', 'export', 'search', 'color', 'import', 'clipboard', 'lenShort', 'lenMedium', 'lenLong']
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
        clipboard: '从剪贴板捕获',
        lenShort: '短便签（≤20 字）',
        lenMedium: '中便签（21–80 字）',
        lenLong: '长便签（>80 字）',
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

      // 便签长度分布：语音输入值不值得做的唯一证据是「长便签占比」。
      // 只记桶、不记内容，也不新增 note 字段，所以对备份/旧标签页零影响。
      function recordLengthMetric(text) {
        var length = String(text == null ? '' : text).length
        recordMetric(length <= 20 ? 'lenShort' : length <= 80 ? 'lenMedium' : 'lenLong')
      }

      // ------------------------------------------------------------ 剪贴板捕获
      //
      // 便签的第二种输入：内容已经在剪贴板里，不用再「开面板 → 点输入框 → 粘贴 → 删行」。
      // 两种档位：快捷姿势（面板内空白处 Ctrl+V）直接成便签、5 秒可撤销；
      // 菜单档只填进草稿，用户看一眼再记下——防的是「复制了密码/私钥，顺手点一下」。
      // 硬禁止：不做全局 paste 监听式的「粘到哪都记」，那会把粘进聊天框的 API key 抄进便签。
      var CLIP_MAX = 2000
      var CLIP_REJECT = 8000
      var CLIP_PREVIEW = 30

      // 只清真正的零宽垃圾（ZWSP / BOM）。ZWNJ(\u200c) / ZWJ(\u200d) 是语义连接符，
      // 不能当垃圾删：删掉 ZWJ 会把「👨‍👩‍👧」拆成三个 emoji，删掉 ZWNJ 会把
      // 波斯语/印地语单词改成另一个词（میروم → میروم）。用户粘什么就该记什么。
      function cleanClipText(raw) {
        return String(raw == null ? '' : raw)
          .replace(/[\u200b\ufeff]/g, '')
          .replace(/\r\n?/g, '\n')
          .trim()
      }

      // 焦点在可编辑元素里时，Ctrl+V 必须原样交给浏览器：不拦、不抢。
      function isEditableTarget(target) {
        if (!target || typeof target !== 'object') return false
        var tag = String(target.tagName || target.type || '').toUpperCase()
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
        if (target.isContentEditable === true) return true
        try {
          if (typeof target.closest === 'function' && target.closest('input, textarea, [contenteditable="true"]')) return true
        } catch (error) {
          // 老环境没有 closest：上面的 tagName 判断已经够用。
        }
        return false
      }

      function clipPreview(text) {
        var value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
        return value.length > CLIP_PREVIEW ? value.slice(0, CLIP_PREVIEW) + '…' : value
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
        'tab.draft': '有草稿还没记下',
        'sub.empty': '随手记',
        unit: '条',
        export: '导出为 Markdown',
        'menu.more': '更多操作',
        'menu.resort': '重排：按最近改动',
        'menu.backup': '导出备份（JSON）',
        'menu.restore': '从备份恢复…',
        'menu.clipboard': '从剪贴板记下（先进草稿）',
        'toast.imported': '已导入',
        'toast.updated': '更新',
        'toast.backedUp': '备份已导出',
        'toast.copied': '已复制这条便签',
        'toast.copyFailed': '复制失败，请手动选择文本',
        'toast.importFailed': '不是本插件的备份文件',
        'toast.importEmpty': '备份文件里没有便签',
        'toast.clipCreated': '已从剪贴板记下',
        'toast.clipToDraft': '已放入草稿，看一眼再记下',
        'toast.clipEmpty': '剪贴板里没有文字',
        'toast.clipDuplicate': '这条已经在列表里',
        'toast.clipTooLong': '内容太长，便签不是剪藏（上限 8000 字）',
        'toast.clipLongDraft': '内容有点长，已放进草稿',
        'toast.clipUnavailable': '这个环境读不到剪贴板，可以点输入框按 Ctrl+V',
        close: '收起便签栏',
        'close.esc': '收起便签栏（Esc）',
        'composer.placeholder': '写下此刻的想法…（Ctrl+Enter 记下）',
        'composer.aria': '新便签内容',
        saving: '保存中…',
        saved: '已自动保存到本机',
        'save.failed': '保存失败，请先导出',
        save: '记下',
        'search.placeholder': '搜索便签…（Ctrl+K；#标签 可按标签筛）',
        'review.label': '翻到一条',
        'review.expand': '展开这条旧便签',
        'review.collapse': '收起这条旧便签',
        'review.dismiss': '今天不再显示',
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
        'note.color': '选择重要程度',
        'color.pick': '选择重要程度',
        'color.current': '重要程度：',
        'color.filter': '按重要程度筛选',
        'color.any': '全部',
        'priority.1': '最要紧',
        'priority.2': '要紧',
        'priority.3': '一般',
        'priority.4': '靠后',
        'priority.5': '未排',
        'priority.change': '点击更换',
        'note.delete': '删除这条便签（可撤销）',
        'note.archive': '归档这条便签',
        'note.restore': '恢复这条便签',
        'note.source': '跳到写这条便签的会话',
        'note.source.unknown': '其他会话',
        'toast.sourceFailed': '打不开那个会话',
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
        'metric.color': '换色',
        'metric.import': '导入备份',
        'metric.clipboard': '从剪贴板捕获',
        'metric.lenShort': '短便签（≤20 字）',
        'metric.lenMedium': '中便签（21–80 字）',
        'metric.lenLong': '长便签（>80 字）',
      }

      var EN = {
        name: 'Notes',
        'tab.title': 'Notes (Alt+Shift+N)',
        'tab.open': 'Open notes',
        'tab.draft': 'Draft not saved yet',
        'sub.empty': 'Jot something',
        unit: 'notes',
        export: 'Export as Markdown',
        'menu.more': 'More actions',
        'menu.resort': 'Re-sort: by last edited',
        'menu.backup': 'Export backup (JSON)',
        'menu.restore': 'Restore from backup…',
        'menu.clipboard': 'Capture clipboard into draft',
        'toast.imported': 'Imported',
        'toast.updated': 'updated',
        'toast.backedUp': 'Backup exported',
        'toast.copied': 'Note copied',
        'toast.copyFailed': "Couldn't copy — select the text manually",
        'toast.importFailed': "This isn't a notes backup file",
        'toast.importEmpty': 'That backup has no notes',
        'toast.clipCreated': 'Captured from clipboard',
        'toast.clipToDraft': 'Added to the draft — review, then save',
        'toast.clipEmpty': 'The clipboard has no text',
        'toast.clipDuplicate': 'That note is already in the list',
        'toast.clipTooLong': 'Too long for a note (8000 char limit)',
        'toast.clipLongDraft': 'Long text — added to the draft',
        'toast.clipUnavailable': "Can't read the clipboard here — click the input and press Ctrl+V",
        close: 'Collapse notes',
        'close.esc': 'Collapse notes (Esc)',
        'composer.placeholder': 'Jot something… (Ctrl+Enter to save)',
        'composer.aria': 'New note',
        saving: 'Saving…',
        saved: 'Saved locally',
        'save.failed': "Couldn't save — export first",
        save: 'Save',
        'search.placeholder': 'Search notes… (Ctrl+K, #tags work)',
        'review.label': 'From earlier',
        'review.expand': 'Expand this older note',
        'review.collapse': 'Collapse this note',
        'review.dismiss': "Don't show again today",
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
        'note.color': 'Choose importance',
        'color.pick': 'Choose importance',
        'color.current': 'Importance: ',
        'color.filter': 'Filter by importance',
        'color.any': 'All',
        'priority.1': 'Top',
        'priority.2': 'High',
        'priority.3': 'Normal',
        'priority.4': 'Later',
        'priority.5': 'Unset',
        'priority.change': 'click to change',
        'note.delete': 'Delete this note (undoable)',
        'note.archive': 'Archive this note',
        'note.restore': 'Restore this note',
        'note.source': 'Jump to the session this note came from',
        'note.source.unknown': 'Other session',
        'toast.sourceFailed': "Couldn't open that session",
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
        'metric.color': 'Color changes',
        'metric.import': 'Backups restored',
        'metric.clipboard': 'Clipboard captures',
        'metric.lenShort': 'Short notes (≤20 chars)',
        'metric.lenMedium': 'Medium notes (21–80 chars)',
        'metric.lenLong': 'Long notes (>80 chars)',
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

      // 「这条便签写在哪个会话里」：一个指出去的小箭头（点了跳回原会话）。
      function IconSource(size) {
        return pick(
          'IconArrowUpRightOutlineRegular',
          function (s) {
            return svg(
              [
                h('path', { key: 'a', d: 'M7 17L17 7' }),
                h('path', { key: 'b', d: 'M9 7h8v8' }),
              ],
              s,
            )
          },
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
        // 外部需要拿到这个 textarea（打开面板时要聚焦草稿框）：用函数 ref 顺手转发出去。
        // 用函数 ref 而不是再挂一个 useEffect，是因为 commit 阶段就赋值好了，
        // 父组件的 effect 里能立刻拿到节点，不依赖 effect 的先后顺序。
        var bindRef = function (node) {
          ref.current = node
          var external = props.inputRef
          if (external && typeof external === 'object') external.current = node
        }
        useEffect(
          function () {
            var el = ref.current
            if (!el) return
            el.style.height = 'auto'
            el.style.height = Math.min(el.scrollHeight, 420) + 'px'
          },
          [props.value],
        )
        var rest = Object.assign({}, props)
        delete rest.inputRef
        return h('textarea', Object.assign(rest, { ref: bindRef }))
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

      /**
       * 会话 id → 标题，只为在卡片上标出「这条便签写在哪个会话里」。
       * 选择器返回 state.byId 本身：引用稳定，会话列表没变就不额外重渲染；
       * 往下传给卡片的只有一个字符串，所以 memo 仍能跳过无关卡片。
       */
      function selectSessionRows(state) {
        return state && state.byId ? state.byId : null
      }

      function useSessionTitles(props) {
        var source = props && typeof props.useSessions === 'function' ? props.useSessions : null
        if (source) {
          try {
            var rows = source(selectSessionRows)
            if (!rows) return null
            var titles = {}
            for (var id in rows) {
              if (!Object.prototype.hasOwnProperty.call(rows, id)) continue
              var row = rows[id]
              var title = row && typeof row.title === 'string' ? row.title.trim() : ''
              if (title) titles[id] = title
            }
            return titles
          } catch (error) {
            return null
          }
        }
        // 和 useActiveSessionId 一样：没 kit 时也占住 hook 槽位，保证 hook 顺序稳定。
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

      // ------------------------------------------------------------ 标签
      //
      // 没有标签表、没有额外字段：标签就是正文里的 `#xxx`，用的时候现解析。
      // 这样标签不会和数据格式 / 备份格式耦合——老备份、老便签照样能用。
      // 允许字母、数字、下划线和连字符（含中文）；遇到空格或标点就结束。
      var TAG_PATTERN = /#([\p{L}\p{N}_-]+)/gu
      // 同一条便签每个渲染 pass 都会被问一次标签：按正文缓存，别每次按键重跑正则。
      var tagCache = {}

      function tagsOf(text) {
        var source = String(text == null ? '' : text)
        var cached = tagCache[source]
        if (cached) return cached
        var tags = []
        TAG_PATTERN.lastIndex = 0
        var match = TAG_PATTERN.exec(source)
        while (match) {
          var tag = match[1].toLowerCase()
          if (tags.indexOf(tag) === -1) tags.push(tag)
          match = TAG_PATTERN.exec(source)
        }
        // 缓存别无限长：正文一改就是一个新 key，随手清掉最省事。
        if (Object.keys(tagCache).length > 400) tagCache = {}
        tagCache[source] = tags
        return tags
      }

      /**
       * 把搜索词编译成「条件」：按空格切 token，`#` 开头的是标签条件（前缀匹配，
       * 所以打 `#想` 能筛出 `#想法`），其余是正文关键词。多个条件 AND。
       *
       * 单条缓存：父组件筛列表、每张卡片画高亮都要同一份结果，按 query 字符串命中即可。
       */
      var lastSearchKey = null
      var lastSearchValue = null

      function buildSearch(raw) {
        var text = String(raw == null ? '' : raw).trim()
        var search = { active: false, tags: [], words: [], parts: [], pattern: '' }
        if (!text) return search
        var tokens = text.split(/\s+/)
        for (var i = 0; i < tokens.length; i += 1) {
          var token = tokens[i]
          if (!token) continue
          if (token.charAt(0) === '#') {
            var tag = token.slice(1).toLowerCase()
            if (tag && search.tags.indexOf(tag) === -1) search.tags.push(tag)
          } else if (search.words.indexOf(token.toLowerCase()) === -1) {
            search.words.push(token.toLowerCase())
          }
        }
        // 高亮用：标签连 `#` 一起标；长的先匹配，免得 `#想法` 被 `#想` 抢先切碎。
        for (var t = 0; t < search.tags.length; t += 1) search.parts.push('#' + search.tags[t])
        for (var w = 0; w < search.words.length; w += 1) search.parts.push(search.words[w])
        search.parts.sort(function (a, b) {
          return b.length - a.length
        })
        search.active = search.tags.length > 0 || search.words.length > 0
        if (search.parts.length) search.pattern = search.parts.map(escapeRegExp).join('|')
        return search
      }

      function searchOf(query) {
        var key = String(query == null ? '' : query)
        if (key === lastSearchKey) return lastSearchValue
        lastSearchKey = key
        lastSearchValue = buildSearch(key)
        return lastSearchValue
      }

      function matchesSearch(note, search) {
        var text = String(note && note.text != null ? note.text : '').toLowerCase()
        for (var w = 0; w < search.words.length; w += 1) {
          if (text.indexOf(search.words[w]) === -1) return false
        }
        if (!search.tags.length) return true
        var tags = tagsOf(note.text)
        for (var t = 0; t < search.tags.length; t += 1) {
          var want = search.tags[t]
          var hit = false
          for (var i = 0; i < tags.length; i += 1) {
            if (tags[i].indexOf(want) === 0) {
              hit = true
              break
            }
          }
          if (!hit) return false
        }
        return true
      }

      function highlightSegments(text, search) {
        var source = String(text == null ? '' : text)
        if (!search || !search.pattern) return [source]
        var parts = source.split(new RegExp('(' + search.pattern + ')', 'gi'))
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
        // 相对时间文案由父组件算好传进来。别传 tick：tick 每 30 秒变一次，
        // 传下来会让 300 张卡片的 memo 全部失效；传字符串则只有文案真变了的那几张重渲染。
        var timeText = props.timeText
        var t = props.t
        var onChange = props.onChange
        var onCommit = props.onCommit
        var onRemove = props.onRemove
        var onCopy = props.onCopy
        // 色点现在是「打开调色板」，不再是循环换色：语义选择必须能一眼看到全部选项。
        var onColor = props.onColor
        // 只有「正在选色的那张卡片」才会收到这两个 prop（见父组件的按需加 prop 说明）。
        var paletteOpen = props.paletteOpen === true
        var onPickColor = props.onPickColor
        var onTogglePin = props.onTogglePin
        var onArchive = props.onArchive
        var onUnarchive = props.onUnarchive
        var onDragStart = props.onDragStart
        var onDrop = props.onDrop
        var onMoveBy = props.onMoveBy
        // 这条便签写在别的会话里时，父组件传来那个会话的标题；null = 不显示来源。
        // 传字符串而不是「取标题的函数」：memo 按值比较，会话列表刷新时卡片不会白渲染。
        var sourceTitle = typeof props.sourceTitle === 'string' && props.sourceTitle ? props.sourceTitle : null
        var onOpenSource = props.onOpenSource

        var archived = note.archived === true
        var query = props.query || ''
        var search = searchOf(query)
        var editing = props.editing === true
        var onStartEdit = props.onStartEdit
        // 搜索时把正文切成「只读 + 高亮」：textarea 里画不了 <mark>。
        // 点一下这一条就切回可编辑（只有这一条，其它仍是只读），不打断「正在找什么」。
        // 只敲一个 `#` 还不算搜索（没有任何条件），列表和卡片都保持原样。
        var readingOnly = search.active && !editing

        return h(
          'article',
          {
            // 重复内容不新增时，用这个属性把那张卡滚进视野并闪一下。
            'data-dsn-note': note.id,
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
                highlightSegments(note.text, search),
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
            h('span', { className: 'dsn-time', title: new Date(note.updatedAt).toLocaleString() }, timeText),
            note.pinned && !archived ? h('span', { className: 'dsn-pin-mark' }, t('note.pinned')) : null,
            archived ? h('span', { className: 'dsn-archived-mark' }, t('filter.archived')) : null,
            // 来源会话：Windows 便签「自动记录来源」的对应物，只不过我们记的是会话 id，
            // 比「哪个 app」更准。点一下跳回那个会话；宿主服务缺失时下面会如实提示。
            sourceTitle
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsn-source',
                    title: t('note.source') + ' · ' + sourceTitle,
                    'aria-label': t('note.source'),
                    onClick: function (event) {
                      if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                      if (typeof onOpenSource === 'function') onOpenSource(note.sessionId)
                    },
                  },
                  h('span', { className: 'dsn-source-icon' }, IconSource(11)),
                  h('span', { className: 'dsn-source-text' }, sourceTitle),
                )
              : null,
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
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsn-dot-btn' + (paletteOpen ? ' is-open' : ''),
                    // 数字 + 文字一起写进 aria-label / title：颜色不能是唯一信息通道。
                    title: t('color.current') + priorityText(t, note.color),
                    'aria-label': t('color.current') + priorityText(t, note.color) + '，' + t('priority.change'),
                    'aria-expanded': paletteOpen ? 'true' : 'false',
                    'aria-haspopup': 'true',
                    onClick: function () {
                      onColor(note.id)
                    },
                  },
                  h('span', { className: 'dsn-dot' }),
                  // 「未排」不画数字：没排过就是没排过，不假装它是个优先级。
                  levelOf(note.color).level < PRIORITY_LEVELS.length
                    ? h('span', { className: 'dsn-rank', 'aria-hidden': 'true' }, String(levelOf(note.color).level))
                    : null,
                ),
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
          // 调色板：内联展开（不做浮层），所以不会被列滚动裁掉、也不用处理定位。
          // 每个选项都是「色块 + 档位数字 + 档位名」，选色不用试、读屏也念得出。
          paletteOpen
            ? h(
                'div',
                { className: 'dsn-palette', role: 'group', 'aria-label': t('color.pick') },
                COLOR_IDS.map(function (colorId) {
                  var current = colorId === note.color
                  return h(
                    'button',
                    {
                      key: colorId,
                      type: 'button',
                      className: 'dsn-palette-option dsn-c-' + colorId + (current ? ' is-current' : ''),
                      title: priorityText(t, colorId),
                      'aria-label': priorityText(t, colorId),
                      'aria-pressed': current ? 'true' : 'false',
                      onClick: function () {
                        if (typeof onPickColor === 'function') onPickColor(note.id, colorId)
                      },
                    },
                    h('span', { className: 'dsn-palette-swatch' }),
                    h('span', { className: 'dsn-palette-name' }, priorityText(t, colorId)),
                  )
                }),
              )
            : null,
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
        // 会话标题表：只用来给「别的会话里写的便签」标来源。
        var sessionTitles = useSessionTitles(props)
        var [store, setStore] = useState(readStore)
        var [draft, setDraft] = useState(readDraft)
        var [tick, setTick] = useState(Date.now())
        var [dirty, setDirty] = useState(false)
        // 上一次落盘是否失败（存储满、被禁用）：失败时不能继续显示「已保存」。
        var [saveFailed, setSaveFailed] = useState(false)
        var [query, setQuery] = useState('')
        // 搜索态下点中某一条：只把这一条切回可编辑，其余仍是只读高亮。
        var [editingId, setEditingId] = useState(null)
        // 颜色：哪张卡片打开了调色板（一次只开一个）、搜索区选中的颜色、颜色菜单是否展开。
        var [paletteId, setPaletteId] = useState(null)
        var [colorFilter, setColorFilter] = useState(null)
        var [colorMenuOpen, setColorMenuOpen] = useState(false)
        // 'all' 或 'archived'：归档视图切换。
        var [view, setView] = useState('all')
        // 删除后 5 秒内可撤销：{ note } 或 null。
        var [undoState, setUndoState] = useState(null)
        // 备份菜单（低频操作收进「更多」，头部按钮数量不变）。
        var [menuOpen, setMenuOpen] = useState(false)
        // 回顾条：今天挑中的那条旧便签 { day, id, hidden } 与它的展开态。
        var [review, setReview] = useState(readReview)
        var [reviewExpanded, setReviewExpanded] = useState(false)
        // 左列右边界：便签栏贴着它展开，不压住会话列表。
        var [leftInset, setLeftInset] = useState(measureSidebarLeft)
        var saveTimer = useRef(0)
        var undoTimer = useRef(0)
        var panelRef = useRef(null)
        var tabRef = useRef(null)
        // 草稿输入框：打开面板时把焦点放进去（「唤起即写」），不用 DOM 查询。
        var draftRef = useRef(null)
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
        // 上一次成功落盘（或从另一页读进来）的那一份列表。
        // 和它比才知道哪些 id 是「本页还没落盘的改动」——多标签页合并全靠这个判断。
        var lastSavedNotes = useRef(store.notes)
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
        var search = searchOf(query)
        // 颜色筛选和搜索词一样属于「找东西」：有任何一个，列表就看全部（含归档），
        // 过滤标签同步高亮「全部」，否则标签和结果对不上。
        var filterActive = search.active || Boolean(colorFilter)
        var activeTab = filterActive ? 'all' : view
        var filteredNotes = useMemo(
          function () {
            if (!filterActive) return baseList
            return notes.filter(function (note) {
              if (!matchesSearch(note, search)) return false
              // 颜色与 `#标签` / 关键词是「且」：先按文字条件筛，再按颜色收窄。
              return !colorFilter || note.color === colorFilter
            })
          },
          [baseList, filterActive, search, colorFilter, notes],
        )
        // 各色条数：按当前搜索词算、但不叠加颜色条件——菜单里直接告诉你「选了会剩几条」。
        var colorCounts = useMemo(
          function () {
            var counts = {}
            for (var i = 0; i < COLOR_IDS.length; i += 1) counts[COLOR_IDS[i]] = 0
            var total = 0
            for (var j = 0; j < notes.length; j += 1) {
              var note = notes[j]
              if (!matchesSearch(note, search)) continue
              total += 1
              if (counts[note.color] !== undefined) counts[note.color] += 1
            }
            counts.all = total
            return counts
          },
          [notes, search],
        )
        var searchable = notes.length >= SEARCH_THRESHOLD

        // 回顾条只在「今天挑的那条、还没关、还在、不是归档」时出现；
        // 搜索态与归档视图里让位——那时列表本身才是焦点。
        var reviewNote = useMemo(
          function () {
            if (!review || !review.id || review.hidden) return null
            if (review.day !== dayKey(Date.now())) return null
            var note = findIn(notes, review.id)
            if (!note || note.archived === true) return null
            return note
          },
          [review, notes],
        )
        var showReview = Boolean(reviewNote) && !filterActive && view === 'all'

        var dismissReview = useCallback(function () {
          setReview(function (prev) {
            if (!prev || !prev.id) return prev
            var next = { day: prev.day, id: prev.id, hidden: true }
            writeReview(next)
            return next
          })
          setReviewExpanded(false)
        }, [])

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
              // 定时器 id 归零：避免 flushNow 去清一个已经到期的定时器。
              saveTimer.current = 0
              var snapshot = latestStore.current.notes
              var ok = writeNotes(snapshot)
              // 只有真写进去才更新快照：多标签页合并靠它判断哪些 id 还没落盘。
              if (ok) lastSavedNotes.current = snapshot
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
            var snapshot = latestStore.current.notes
            var ok = writeNotes(snapshot)
            if (ok) lastSavedNotes.current = snapshot
            else setSaveFailed(true)
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
        // 关键：本页可能正打着字、还没到 300ms 的落盘点，这时整份替换会把本页的字冲掉。
        // 所以先看本页有没有未落盘的改动：没有就整份采用；有就按 id 合并（见 mergeIncomingNotes）。
        useEffect(function () {
          function onStorage(event) {
            if (event.key !== STORAGE_KEY) return
            var incoming = readNotes()
            var local = latestStore.current.notes
            if (sameNoteList(local, lastSavedNotes.current)) {
              // 本页干净：直接采用另一页的版本（和原来的行为一致）。
              if (sameNoteList(local, incoming)) return
              lastSavedNotes.current = incoming
              setStore(function (prev) {
                return { notes: incoming, open: prev.open }
              })
              setDirty(false)
              return
            }
            // 本页有还没落盘的改动：合并，保住本页正在打的内容（别整份覆盖）。
            var merged = mergeIncomingNotes(local, lastSavedNotes.current, incoming)
            if (sameNoteList(merged, local)) return
            setStore(function (prev) {
              return sameNoteList(prev.notes, merged) ? prev : { notes: merged, open: prev.open }
            })
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
          // 收起面板时把「找东西」的临时状态一并复位，下次打开是干净的一张列表。
          setColorFilter(null)
          setColorMenuOpen(false)
          setPaletteId(null)
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

        // Esc 从内到外逐层退出：菜单 → 卡片调色板 → 颜色菜单 → 搜索词 → 颜色筛选 → 收起面板。
        useEffect(
          function () {
            if (!open) return undefined
            function onKeyDown(event) {
              if (event.key === 'Escape') {
                // 输入法组词中的 Esc 是「取消候选」，不是「退出面板」：别拦、别清搜索词、也别收面板。
                // 只判 isComposing 不够——Safari 常在 compositionend 之后才发结束组词的那次 keydown，
                // 所以 keyCode 229 一起判（和草稿框 Ctrl+Enter 那处同一个坑）。
                if (event.isComposing || event.keyCode === 229) return
                event.stopPropagation()
                if (menuOpen) {
                  setMenuOpen(false)
                  return
                }
                if (paletteId) {
                  setPaletteId(null)
                  return
                }
                if (colorMenuOpen) {
                  setColorMenuOpen(false)
                  return
                }
                if (query) {
                  setQuery('')
                  return
                }
                if (colorFilter) {
                  setColorFilter(null)
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
          [open, close, query, menuOpen, paletteId, colorMenuOpen, colorFilter],
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

        // 打开时把焦点放到输入框（点标签、按 Alt+Shift+N、Esc 之后重开都算）：
        // 「唤起即写」，用户不用再点一次输入框。首帧不抢焦点——页面加载时可能正有别的输入框在用。
        var firstRender = useRef(true)
        useEffect(
          function () {
            if (firstRender.current) {
              firstRender.current = false
              return
            }
            if (!open) return
            var input = draftRef.current
            if (input && typeof input.focus === 'function') input.focus()
          },
          [open],
        )

        // 回顾条：每次打开面板看一眼有没有今天的旧便签。同一天只挑一次，
        // 否则打字（列表变化）时会一直换人，变成噪音。收起时把展开态复位。
        useEffect(
          function () {
            if (!open) {
              if (reviewExpanded) setReviewExpanded(false)
              return
            }
            var today = dayKey(Date.now())
            if (review && review.day === today) return
            var pick = pickReviewNote(latestStore.current.notes, review && review.id)
            var next = { day: today, id: pick ? pick.id : '', hidden: false }
            writeReview(next)
            setReview(next)
          },
          [open, review, reviewExpanded],
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
              color: DEFAULT_COLOR,
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
          // 不 setTick：tick 一变所有卡片的 memo 都会失效，300 条时要白画 300 张卡。
          // 新便签的 updatedAt 就是现在，用 30 秒心跳的旧 tick 算出来仍然是「刚刚」。
          recordMetric('create')
          recordLengthMetric(value)
        }, [activeSessionId])

        // 剪贴板捕获的统一入口：
        //   mode 'note'  = 快捷档，直接成一条便签（toast 里给预览 + 5 秒撤销）；
        //   mode 'draft' = 菜单档，只填进草稿，用户看一眼再 Ctrl+Enter。
        function findDuplicate(text) {
          var list = latestStore.current.notes
          for (var i = 0; i < list.length; i += 1) {
            if (list[i].text === text) return list[i]
          }
          return null
        }

        // 重复内容不新增，滚过去闪一下，让用户看到「已经有了」。
        function highlightNote(id) {
          try {
            if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return
            var el = document.querySelector('[data-dsn-note="' + String(id) + '"]')
            if (!el) return
            if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' })
            if (el.classList && typeof el.classList.add === 'function') {
              el.classList.add('is-flash')
              window.setTimeout(function () {
                if (el.classList && typeof el.classList.remove === 'function') el.classList.remove('is-flash')
              }, 1400)
            }
          } catch (error) {
            // 高亮失败不影响已经完成的捕获。
          }
        }

        var captureFromText = useCallback(
          function (raw, mode) {
            var value = cleanClipText(raw)
            if (!value) {
              showToast({ kind: 'error', text: t('toast.clipEmpty') }, 2400)
              return
            }
            if (value.length > CLIP_REJECT) {
              showToast({ kind: 'error', text: t('toast.clipTooLong') }, 3200)
              return
            }
            var existing = findDuplicate(value)
            if (existing) {
              highlightNote(existing.id)
              showToast({ kind: 'info', text: t('toast.clipDuplicate') }, 2400)
              return
            }
            // 太长的不适合直接成卡：退到草稿，让用户自己删减。
            if (value.length > CLIP_MAX && mode === 'note') {
              setDraft(value)
              showToast({ kind: 'info', text: t('toast.clipLongDraft') }, 3200)
              recordMetric('clipboard')
              recordLengthMetric(value)
              return
            }
            if (mode === 'draft') {
              setDraft(value)
              showToast({ kind: 'info', text: t('toast.clipToDraft') }, 2400)
              recordMetric('clipboard')
              recordLengthMetric(value)
              return
            }
            var now = Date.now()
            var note = {
              id: newId(),
              text: value,
              color: DEFAULT_COLOR,
              pinned: false,
              archived: false,
              archivedAt: 0,
              sessionId: activeSessionId,
              createdAt: now,
              updatedAt: now,
              order: nextOrder(latestStore.current.notes),
            }
            setStore(function (prev) {
              return { notes: [note].concat(prev.notes).slice(0, MAX_NOTES), open: true }
            })
            // 不 setTick：理由同上，记一条不该让整个列表重画。
            recordMetric('create')
            recordLengthMetric(value)
            recordMetric('clipboard')
            showToast({ kind: 'clip', note: note, preview: clipPreview(value) }, UNDO_MS)
          },
          [t, activeSessionId],
        )

        // 面板打开时，空白处 Ctrl+V = 从剪贴板直接记一条。
        // 焦点在任何输入框里时完全不拦（原生粘贴），也绝不注册「粘到哪都记」的全局监听。
        useEffect(
          function () {
            if (!open) return undefined
            if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
            function onPaste(event) {
              if (isEditableTarget(event.target)) return
              var data = event.clipboardData
              if (!data || typeof data.getData !== 'function') return
              var text = ''
              try {
                text = data.getData('text/plain')
              } catch (error) {
                text = ''
              }
              if (!cleanClipText(text)) return
              if (typeof event.preventDefault === 'function') event.preventDefault()
              captureFromText(text, 'note')
            }
            document.addEventListener('paste', onPaste, true)
            return function () {
              document.removeEventListener('paste', onPaste, true)
            }
          },
          [open, captureFromText],
        )
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

        // 换色：只换 color，**不动 updatedAt**——换色不是「改了内容」，不该把便签顶到最上面。
        var setNoteColor = useCallback(function (id, color) {
          if (COLOR_IDS.indexOf(color) === -1) return
          setStore(function (prev) {
            var next = prev.notes.map(function (note) {
              if (note.id !== id || note.color === color) return note
              return { id: note.id, text: note.text, color: color, pinned: note.pinned, archived: note.archived, archivedAt: note.archivedAt, sessionId: note.sessionId, order: note.order, createdAt: note.createdAt, updatedAt: note.updatedAt }
            })
            return { notes: next, open: prev.open }
          })
          // 先量有没有人真的用颜色，再决定要不要继续加语义。
          recordMetric('color')
        }, [])

        // 点击色点开/关调色板：一次只开一个，再点同一个就收起。
        var togglePalette = useCallback(function (id) {
          setPaletteId(function (prev) {
            return prev === id ? null : id
          })
        }, [])

        var chooseColor = useCallback(
          function (id, color) {
            setNoteColor(id, color)
            setPaletteId(null)
          },
          [setNoteColor],
        )

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
          // 从剪贴板直接成卡的提示：带上前 30 字，让用户确认「记对了东西」。
          if (pending.kind === 'clip') return t('toast.clipCreated') + (pending.preview ? ' · ' + pending.preview : '')
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

        // 「跳到原会话」：走宿主的 uiWorkspace.openSession。跳不过去就如实说一句，
        // 不静默失败——用户点了一下却毫无反应比报错更糟。
        // 依赖里的 t 只在切语言时变一次，而那时所有卡片本来就要重渲染。
        var openSourceSession = typeof props.openSourceSession === 'function' ? props.openSourceSession : null
        var openSource = useCallback(
          function (sessionId) {
            if (!openSourceSession) return
            var ok = false
            try {
              ok = openSourceSession(sessionId) === true
            } catch (error) {
              ok = false
            }
            if (!ok) showToast({ kind: 'info', text: t('toast.sourceFailed') }, 3200)
          },
          [t, openSourceSession],
        )

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

        // 菜单档：先读剪贴板、再填进草稿（不直接建卡）。读不到就如实说，并给手动粘贴的退路。
        var captureClipboardToDraft = useCallback(function () {
          var nav = typeof navigator !== 'undefined' && navigator ? navigator : null
          var clipboard = nav && nav.clipboard ? nav.clipboard : null
          if (!clipboard || typeof clipboard.readText !== 'function') {
            showToast({ kind: 'error', text: t('toast.clipUnavailable') }, 3200)
            return
          }
          Promise.resolve(clipboard.readText()).then(
            function (raw) {
              captureFromText(raw, 'draft')
            },
            function () {
              showToast({ kind: 'error', text: t('toast.clipUnavailable') }, 3200)
            },
          )
        }, [captureFromText, t])

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
          if (pending.kind === 'clip') {
            // 从剪贴板直接成卡的撤销 = 把这条再拿走（它是「刚加进来的」，不是「刚删掉的」）。
            setStore(function (prev) {
              return {
                notes: prev.notes.filter(function (note) {
                  return note.id !== pending.note.id
                }),
                open: prev.open,
              }
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
        // 收起后便签栏只剩一个贴边标签，所以「有东西还没处理」要能从这个标签上读出来：
        // 草稿没记下、以及有几条置顶。都在 title / aria-label 里说出来，不只靠颜色。
        var pinnedCount = activeNotes.filter(function (note) {
          return note.pinned && note.text.trim().length > 0
        }).length
        var hasDraft = draft.trim().length > 0
        var tabStatus = []
        if (hasDraft) tabStatus.push(t('tab.draft'))
        if (pinnedCount > 0) tabStatus.push(pinnedCount + ' ' + t('note.pinned'))

        var tab = h(
          'button',
          {
            type: 'button',
            className: 'dsn-tab',
            title: tabStatus.length ? t('tab.title') + ' · ' + tabStatus.join(' · ') : t('tab.title'),
            'aria-label': tabStatus.length ? t('tab.open') + '，' + tabStatus.join('，') : t('tab.open'),
            'aria-expanded': open ? 'true' : 'false',
            ref: tabRef,
            onClick: toggle,
          },
          // 草稿点贴右上角，不占布局：便签栏只有 32px 宽，多一行会显得臃肿。
          hasDraft ? h('span', { className: 'dsn-tab-draft', 'aria-hidden': 'true' }) : null,
          h('span', { className: 'dsn-tab-icon' }, IconNote(15)),
          h('span', { className: 'dsn-tab-text' }, t('name')),
          pinnedCount > 0
            ? h('span', { className: 'dsn-tab-pin', 'aria-hidden': 'true' }, IconPin(11))
            : null,
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
                  // 剪贴板捕获的「安全档」：先填草稿，用户看一眼再记下。
                  h(
                    'button',
                    {
                      type: 'button',
                      role: 'menuitem',
                      className: 'dsn-menu-item',
                      onClick: function () {
                        setMenuOpen(false)
                        captureClipboardToDraft()
                      },
                    },
                    IconCopy(14),
                    h('span', null, t('menu.clipboard')),
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
              inputRef: draftRef,
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
                      setColorFilter(null)
                      setColorMenuOpen(false)
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
                          setColorFilter(null)
                          setColorMenuOpen(false)
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
                      setColorFilter(null)
                      setColorMenuOpen(false)
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
                // 颜色筛选：和搜索同属「找东西」，所以放在搜索框左侧——不另起一排常驻图例，
                // 首屏仍然留给列表。选中后按钮变成「色点 + 色名」，色名就是非颜色通道。
                h(
                  'button',
                  {
                    type: 'button',
                    className:
                      'dsn-color-trigger' +
                      (colorFilter ? ' is-active dsn-c-' + colorFilter : '') +
                      (colorMenuOpen ? ' is-open' : ''),
                    title: colorFilter ? t('color.current') + priorityText(t, colorFilter) : t('color.filter'),
                    'aria-label': colorFilter ? t('color.current') + priorityText(t, colorFilter) : t('color.filter'),
                    'aria-haspopup': 'true',
                    'aria-expanded': colorMenuOpen ? 'true' : 'false',
                    onClick: function () {
                      setColorMenuOpen(!colorMenuOpen)
                    },
                  },
                  h('span', { className: 'dsn-color-dot' }),
                  colorFilter ? h('span', { className: 'dsn-color-trigger-name' }, priorityText(t, colorFilter)) : null,
                ),
                colorMenuOpen
                  ? h(
                      'div',
                      { className: 'dsn-color-menu', role: 'group', 'aria-label': t('color.filter') },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsn-color-item' + (colorFilter ? '' : ' is-current'),
                          'aria-pressed': colorFilter ? 'false' : 'true',
                          onClick: function () {
                            setColorFilter(null)
                            setColorMenuOpen(false)
                          },
                        },
                        h('span', { className: 'dsn-color-item-dot' }),
                        h('span', { className: 'dsn-color-item-label' }, t('color.any')),
                        h('span', { className: 'dsn-color-item-count' }, String(colorCounts.all)),
                      ),
                      COLOR_IDS.map(function (colorId) {
                        var selected = colorFilter === colorId
                        var count = colorCounts[colorId] || 0
                        return h(
                          'button',
                          {
                            key: colorId,
                            type: 'button',
                            className:
                              'dsn-color-item dsn-c-' + colorId + (selected ? ' is-current' : '') + (count === 0 ? ' is-empty' : ''),
                            'aria-pressed': selected ? 'true' : 'false',
                            onClick: function () {
                              setColorFilter(colorId)
                              setColorMenuOpen(false)
                            },
                          },
                          h('span', { className: 'dsn-color-item-dot' }),
                          h('span', { className: 'dsn-color-item-label' }, priorityText(t, colorId)),
                          h('span', { className: 'dsn-color-item-count' }, String(count)),
                        )
                      }),
                    )
                  : null,
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
          // 回顾条：一条旧便签，压在列表上方但只有一行高（点开才展开全文），
          // 所以不抢首屏；`×` 关掉就今天不再打扰。
          showReview
            ? h(
                'div',
                { className: 'dsn-review' + (reviewExpanded ? ' is-expanded' : '') },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsn-review-main',
                    title: reviewExpanded ? t('review.collapse') : t('review.expand'),
                    'aria-expanded': reviewExpanded ? 'true' : 'false',
                    onClick: function () {
                      setReviewExpanded(!reviewExpanded)
                    },
                  },
                  h('span', { className: 'dsn-review-label' }, t('review.label')),
                  h('span', { className: 'dsn-review-text' }, reviewNote.text),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsn-icon-btn dsn-review-close',
                    title: t('review.dismiss'),
                    'aria-label': t('review.dismiss'),
                    onClick: dismissReview,
                  },
                  IconClose(12),
                ),
              )
            : null,
          h(
            'div',
            { className: 'dsn-list' + (undoState ? ' has-toast' : '') },
            filteredNotes.length === 0
              ? h(
                  'div',
                  { className: 'dsn-empty' },
                  h('div', { className: 'dsn-empty-title' }, filterActive ? t('empty.search') : view === 'archived' ? t('empty.archived') : view === 'session' ? t('empty.session') : t('empty.none')),
                  h('div', { className: 'dsn-empty-sub' }, filterActive ? t('empty.search.sub') : view === 'archived' ? t('empty.archived.sub') : view === 'session' ? t('empty.session.sub') : t('empty.none.sub')),
                )
              : filteredNotes.map(function (note) {
                  var cardProps = {
                    key: note.id,
                    note: note,
                    // 相对时间在父组件一次算好：30 秒心跳到点时，文案没变的卡片 memo 得掉。
                    timeText: formatTime(note.updatedAt, tick, timeLabels),
                    t: t,
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
                    onColor: togglePalette,
                    onTogglePin: togglePin,
                    onArchive: archiveNote,
                    onUnarchive: unarchiveNote,
                  }
                  // 只给「别的会话里写的」便签挂来源：本会话的、没会话信息的都保持原来的 props 形状。
                  // 不是洁癖——memo 每次父渲染都要对每张卡片浅比较一遍，300 条时多两个 key
                  // 实测就把稳态渲染从 0.4ms 抬到 0.8ms（test/perf.mjs）。
                  if (activeSessionId && note.sessionId && note.sessionId !== activeSessionId) {
                    cardProps.sourceTitle = (sessionTitles && sessionTitles[note.sessionId]) || t('note.source.unknown')
                    cardProps.onOpenSource = openSource
                  }
                  // 调色板同理：只给「正在选色的那一张」加 prop，其他卡片保持原形状。
                  if (paletteId && paletteId === note.id && note.archived !== true) {
                    cardProps.paletteOpen = true
                    cardProps.onPickColor = chooseColor
                  }
                  return h(NoteCardMemo, cardProps)
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
        // 收起态的两个小提示：草稿点（右上角，不占布局）+ 置顶小图标（在流里，表示「有东西被钉着」）。
        // 两者纯装饰，语义都在贴边标签的 title / aria-label 里，所以不参与对比度门禁。
        '.dsn-tab-draft{position:absolute;top:7px;right:6px;width:8px;height:8px;border-radius:50%;background:var(--dsn-accent);box-shadow:0 0 0 2px var(--dsn-surface)}',
        '.dsn-tab-pin{display:grid;place-items:center;opacity:.75}',
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
        '.dsn-search{position:relative;display:flex;align-items:center;gap:6px;margin:0 14px 8px;padding:0 6px 0 9px;border:1px solid var(--dsn-line);border-radius:9px;background:rgba(127,127,127,.06);min-height:32px}',
        '.dsn-search:focus-within{border-color:var(--dsn-accent)}',
        '.dsn-search-icon{display:grid;place-items:center;color:var(--dsn-fg-2);flex:0 0 auto}',
        // 颜色筛选触发器：平时是一个 12px 色点，选中后变成「色点 + 色名」。
        // 色名是必须的——颜色不能作为唯一信息通道（WCAG 1.4.1），读屏和色盲都靠它。
        '.dsn-color-trigger{display:inline-flex;align-items:center;gap:4px;flex:0 0 auto;min-height:24px;padding:2px 6px;border:0;border-radius:7px;background:transparent;color:var(--dsn-fg-2);font:inherit;font-size:11px;cursor:pointer;transition:background .12s ease,color .12s ease}',
        '.dsn-color-trigger:hover{background:rgba(127,127,127,.16);color:var(--dsn-fg)}',
        '.dsn-color-trigger:focus-visible{outline:2px solid var(--dsn-accent);outline-offset:1px}',
        '.dsn-color-trigger.is-active{background:rgba(127,127,127,.16);color:var(--dsn-fg)}',
        '.dsn-color-dot{width:12px;height:12px;border-radius:50%;background:var(--dsn-sticky,transparent);box-shadow:0 0 0 1.5px var(--dsn-ring)}',
        '.dsn-color-trigger-name{white-space:nowrap;max-width:52px;overflow:hidden;text-overflow:ellipsis}',
        // 颜色菜单是浮层：面板本身不滚动（只有列表滚），所以不会被裁。
        '.dsn-color-menu{position:absolute;left:0;top:calc(100% + 4px);z-index:5;min-width:148px;padding:4px;border:1px solid var(--dsn-line);border-radius:10px;background:var(--dsn-surface);box-shadow:0 10px 26px rgba(0,0,0,.18)}',
        '.dsn-color-item{display:flex;align-items:center;gap:7px;width:100%;min-height:28px;padding:3px 7px;border:0;border-radius:7px;background:transparent;color:var(--dsn-fg);font:inherit;font-size:11.5px;text-align:left;cursor:pointer}',
        '.dsn-color-item:hover{background:rgba(127,127,127,.14)}',
        '.dsn-color-item:focus-visible{outline:2px solid var(--dsn-accent);outline-offset:1px}',
        '.dsn-color-item.is-current{background:rgba(127,127,127,.18);font-weight:600}',
        '.dsn-color-item.is-empty{opacity:.55}',
        '.dsn-color-item-dot{width:12px;height:12px;border-radius:50%;flex:0 0 auto;background:var(--dsn-sticky,transparent);box-shadow:0 0 0 1.5px var(--dsn-ring)}',
        '.dsn-color-item.is-current .dsn-color-item-dot{box-shadow:0 0 0 2px var(--dsn-surface),0 0 0 3.5px var(--dsn-accent)}',
        '.dsn-color-item-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.dsn-color-item-count{flex:0 0 auto;font-size:10.5px;color:var(--dsn-fg-2);font-variant-numeric:tabular-nums}',
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
        // 回顾条：默认只有一行高（~30px），点开才展开正文——所以它占的不是首屏。
        // 虚线框是刻意的：它和真实便签卡片不是一个东西，别让人以为多了一条便签。
        '.dsn-review{display:flex;align-items:center;gap:6px;margin:0 14px 8px;padding:3px 4px 3px 10px;border:1px dashed var(--dsn-line);border-radius:9px;background:rgba(127,127,127,.06);min-height:30px}',
        '.dsn-review.is-expanded{align-items:flex-start}',
        '.dsn-review-main{display:flex;align-items:baseline;gap:6px;flex:1 1 auto;min-width:0;padding:2px 0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}',
        '.dsn-review-main:focus-visible{outline:2px solid var(--dsn-accent);outline-offset:2px;border-radius:5px}',
        '.dsn-review-main:hover .dsn-review-text{color:var(--dsn-fg)}',
        '.dsn-review-label{flex:0 0 auto;font-size:10px;line-height:1.6;color:var(--dsn-fg-2);letter-spacing:.02em}',
        '.dsn-review-text{min-width:0;font-size:12px;line-height:1.5;color:var(--dsn-fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.dsn-review.is-expanded .dsn-review-text{white-space:pre-wrap;overflow-wrap:anywhere;max-height:120px;overflow-y:auto;scrollbar-width:thin}',
        '.dsn-review-close{flex:0 0 auto}',
        '.dsn-list{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:2px 14px 16px;display:flex;flex-direction:column;gap:9px;scrollbar-width:thin}',
        '.dsn-list.has-toast{padding-bottom:64px}',
        '.dsn-list::-webkit-scrollbar{width:8px}',
        '.dsn-list::-webkit-scrollbar-thumb{background:rgba(127,127,127,.32);border-radius:4px}',
        '.dsn-note{--dsn-sticky:#6f52d9;position:relative;border:1px solid var(--dsn-line);border-left:3px solid var(--dsn-sticky);border-radius:11px;background:rgba(127,127,127,.08);padding:7px 8px 4px 16px}',
        // 拖动把手：占住左边缘（色条 + 内边距）那块空隙，平时隐形，hover/聚焦才显形。
        '.dsn-grip{position:absolute;left:1px;top:5px;width:22px;height:24px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsn-fg-2);opacity:0;cursor:grab;display:grid;place-items:center;transition:opacity .12s ease,background .12s ease}',
        '.dsn-note:hover .dsn-grip,.dsn-note:focus-within .dsn-grip{opacity:.7}',
        '.dsn-grip:hover{opacity:1;background:rgba(127,127,127,.16)}',
        '.dsn-grip:focus-visible{opacity:1;outline:2px solid var(--dsn-accent);outline-offset:1px}',
        '.dsn-grip:active{cursor:grabbing}',
        '.dsn-note.is-dragging{opacity:.45}',
        '.dsn-note.is-drop-target{box-shadow:inset 0 0 0 1px var(--dsn-accent)}',
        // 五色 = 五档重要程度。浅色主题用压深一档的值（原来的亮色在浅底上只有 1.73-2.76:1，
        // 达不到图形元素 3:1）；深色主题保持亮色那套（4.11-8.27:1）。数据里存的是色名 id，换色值不动数据。
        '.dsn-c-rose{--dsn-sticky:#c93a5e}',
        '.dsn-c-amber{--dsn-sticky:#b8780a}',
        '.dsn-c-mint{--dsn-sticky:#1d8a5b}',
        '.dsn-c-sky{--dsn-sticky:#1f6fd6}',
        '.dsn-c-violet{--dsn-sticky:#6f52d9}',
        'body[data-ds-dark-theme] .dsn-c-rose{--dsn-sticky:#f4728f}',
        'body[data-ds-dark-theme] .dsn-c-amber{--dsn-sticky:#f0b13a}',
        'body[data-ds-dark-theme] .dsn-c-mint{--dsn-sticky:#3fbd8b}',
        'body[data-ds-dark-theme] .dsn-c-sky{--dsn-sticky:#4f9dff}',
        'body[data-ds-dark-theme] .dsn-c-violet{--dsn-sticky:#a58bfa}',
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
        // 从剪贴板捕获到重复内容时：滚过去闪两下，别让用户以为「没反应」。
        '.dsn-note.is-flash{animation:dsn-flash 1.2s ease-out}',
        '@keyframes dsn-flash{0%,100%{box-shadow:0 0 0 0 rgba(127,127,127,0)}25%,75%{box-shadow:0 0 0 3px var(--dsn-accent)}}',
        '.dsn-archived-mark{font-size:9.5px;line-height:1.6;color:var(--dsn-fg-2);background:rgba(127,127,127,.16);border-radius:6px;padding:0 5px;white-space:nowrap}',
        // 来源会话：和 pin-mark 同一套「正文色压浅灰」的对比度算法（light 5.8 / dark 10.4 起算，
        // 叠加 12% 灰底后仍在 AA 之上）；限宽 + 省略号，长会话名不挤走右侧按钮。
        '.dsn-source{display:inline-flex;align-items:center;gap:4px;max-width:44%;min-height:24px;padding:2px 8px;border:0;border-radius:7px;background:rgba(127,127,127,.12);color:var(--dsn-fg-2);font:inherit;font-size:10.5px;cursor:pointer;overflow:hidden;transition:background .12s ease,color .12s ease}',
        '.dsn-source:hover{background:rgba(127,127,127,.2);color:var(--dsn-fg)}',
        '.dsn-source:focus-visible{outline:2px solid var(--dsn-accent);outline-offset:1px}',
        '.dsn-source-icon{display:grid;place-items:center;flex:0 0 auto;opacity:.85}',
        '.dsn-source-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.dsn-spacer{flex:1 1 auto}',
        '.dsn-dot-btn{display:inline-flex;align-items:center;justify-content:center;gap:3px;min-width:24px;height:24px;padding:0 3px;border:0;border-radius:8px;background:transparent;cursor:pointer;transition:background .12s ease}',
        '.dsn-dot{width:12px;height:12px;border-radius:50%;background:var(--dsn-sticky);box-shadow:0 0 0 1.5px var(--dsn-ring);transition:transform .12s ease}',
        '.dsn-rank{font-size:10px;font-weight:650;line-height:1;color:var(--dsn-fg-2);font-variant-numeric:tabular-nums}',
        '.dsn-dot-btn:hover{background:rgba(127,127,127,.16)}',
        '.dsn-dot-btn:hover .dsn-dot{transform:scale(1.14)}',
        '.dsn-dot-btn:hover .dsn-rank{color:var(--dsn-fg)}',
        '.dsn-dot-btn.is-open{background:rgba(127,127,127,.18)}',
        '.dsn-dot-btn:focus-visible{outline:2px solid var(--dsn-accent);outline-offset:1px}',
        // 调色板：内联展开在卡片底部（不做浮层），所以不会被列表滚动裁掉，也不用算定位。
        '.dsn-palette{display:flex;gap:2px;margin:2px 0 1px;padding:4px 0 2px;border-top:1px dashed var(--dsn-line)}',
        '.dsn-palette-option{display:flex;flex-direction:column;align-items:center;gap:3px;flex:1 1 0;min-width:0;padding:3px 0;border:0;border-radius:7px;background:transparent;color:var(--dsn-fg-2);font:inherit;cursor:pointer}',
        '.dsn-palette-option:hover{background:rgba(127,127,127,.14);color:var(--dsn-fg)}',
        '.dsn-palette-option:focus-visible{outline:2px solid var(--dsn-accent);outline-offset:1px}',
        '.dsn-palette-option.is-current{background:rgba(127,127,127,.12);color:var(--dsn-fg)}',
        '.dsn-palette-swatch{width:16px;height:16px;border-radius:50%;background:var(--dsn-sticky);box-shadow:0 0 0 1.5px var(--dsn-ring)}',
        '.dsn-palette-option.is-current .dsn-palette-swatch{box-shadow:0 0 0 2px var(--dsn-surface),0 0 0 3.5px var(--dsn-accent)}',
        '.dsn-palette-name{max-width:100%;font-size:9px;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
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
        '@media (prefers-reduced-motion: reduce){.dsn-panel,.dsn-toast{animation:none}.dsn-tab,.dsn-save,.dsn-dot-btn,.dsn-dot{transition:none}}',
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

        /**
         * 把「跳到原会话」交给宿主的 uiWorkspace 服务（layout 侧提供 openSession）。
         * 服务是可选能力：拿不到、或宿主内部抛错，都只返回 false 让界面降级成不可点标签，
         * 绝不写进 inject —— 依赖没就绪会把整个插件卡在 waiting。
         */
        function openSourceSession(sessionId) {
          if (typeof sessionId !== 'string' || !sessionId) return false
          var service = null
          try {
            service = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : null
          } catch (error) {
            service = null
          }
          if (!service || typeof service.openSession !== 'function') return false
          try {
            service.openSession(sessionId)
            return true
          } catch (error) {
            return false
          }
        }

        ctx.slots.inject('shell.overlay', function* () {
          yield ctx.slots.register({ name: 'shell.overlay', id: 'sticky-notes', order: 860 }, function (slotProps) {
            // slot 会送来一整套标准 kit（useSessions / usePanelInfo / …）：
            // 必须原样转发下去，否则便签栏读不到「当前会话」。
            return h(
              StickyNotesRoot,
              Object.assign({}, slotProps || {}, { locale: locale, openSourceSession: openSourceSession }),
            )
          })
        })
      }

      module.exports = { apply: apply, inject: inject, name: name }
      return module.exports
    },
  })
})()
