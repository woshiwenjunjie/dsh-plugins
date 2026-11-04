// 对比度回归：从 DSH 主题包的真实 CSS 里解析 token 取值，算 WCAG 对比度。
//
// 为什么要有这一层：0.1.0 曾经踩过「暗色主题下白字压近白底 = 1.05:1」的坑，
// 之后每次加新元素（提示条、高亮、菜单）都可能再踩一次。这份测试把「配色是否达标」
// 从眼睛判断变成可执行的断言。
//
// 找不到 DSH 主题包就 SKIP（CI 上没有安装 DSH，不该因此挂）。
import fs from 'node:fs'

const CANDIDATES = [
  process.env.DSH_THEME_CLIENT,
  'D:\\Dev\\DSH Desktop\\resources\\app.asar\\node_modules\\@deepseek-ai\\dsh-client-ui-theme\\lib\\client.js',
].filter(Boolean)

const themeFile = CANDIDATES.find((file) => {
  try {
    return fs.existsSync(file)
  } catch (error) {
    return false
  }
})

if (!themeFile) {
  console.log('SKIP  对比度：找不到 DSH 主题包（设置 DSH_THEME_CLIENT 指向 ui-theme 的 client.js 可启用）')
  process.exit(0)
}

const css = fs.readFileSync(themeFile, 'utf8')

// ---------------------------------------------------------------- 解析 token
//
// 主题包里的声明分两类作用域：默认（浅色）和 body[data-ds-dark-theme] 覆盖块。
// 这里只关心自定义属性声明，所以按「暗色选择器」切段即可，不需要完整 CSS 解析。

const light = new Map()
const dark = new Map()

function collect(segment, target) {
  const pattern = /(--dsw-[a-z0-9-]+)\s*:\s*([^;}]+)/gi
  let match
  while ((match = pattern.exec(segment)) !== null) {
    target.set(match[1].trim(), match[2].trim())
  }
}

// 暗色覆盖块先整段抠出来收进 dark，剩下的声明都属于默认（浅色）作用域。
// 注意不能用「按选择器切段」的简单做法：浅色 token 块可能排在暗色块之后。
const darkBlocks = []
const darkBlockPattern = /body\[data-ds-dark-theme\][^{]*\{([^}]*)\}/g
let darkMatch
while ((darkMatch = darkBlockPattern.exec(css)) !== null) darkBlocks.push(darkMatch[1])
collect(css.replace(/body\[data-ds-dark-theme\][^{]*\{[^}]*\}/g, ''), light)
for (const block of darkBlocks) collect(block, dark)

function parseColor(text) {
  const value = String(text || '').trim()
  let match = /^#([0-9a-f]{3,8})$/i.exec(value)
  if (match) {
    let hex = match[1]
    if (hex.length === 3 || hex.length === 4) hex = hex.split('').map((c) => c + c).join('')
    const r = parseInt(hex.slice(0, 2), 16)
    const g = parseInt(hex.slice(2, 4), 16)
    const b = parseInt(hex.slice(4, 6), 16)
    const a = hex.length >= 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
    return { r, g, b, a }
  }
  match = /^rgba?\(([^)]+)\)$/i.exec(value)
  if (match) {
    const parts = match[1].split(/[,/\s]+/).filter(Boolean).map(Number)
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }
  }
  return null
}

/** 把 var(--x) 链一路解析到具体颜色；解析不了返回 null。 */
function resolve(name, layer) {
  const table = layer === 'dark' ? dark : light
  const seen = new Set()
  let current = name
  while (current) {
    if (seen.has(current)) return null
    seen.add(current)
    const raw = table.get(current) || light.get(current)
    if (!raw) return null
    const varMatch = /^var\((--[a-z0-9-]+)(?:\s*,\s*([^)]+))?\)$/i.exec(raw.trim())
    if (varMatch) {
      current = varMatch[1]
      continue
    }
    const color = parseColor(raw)
    if (color) return color
    return null
  }
  return null
}

// ---------------------------------------------------------------- 对比度

function channel(value) {
  const c = value / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function luminance(color) {
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
}

function contrast(a, b) {
  const la = luminance(a)
  const lb = luminance(b)
  const lightest = Math.max(la, lb)
  const darkest = Math.min(la, lb)
  return (lightest + 0.05) / (darkest + 0.05)
}

/** 半透明前景/背景叠在底层上后的实际颜色（我们的 mark、提示条背景都用半透明灰）。 */
function over(top, bottom) {
  const a = top.a === undefined ? 1 : top.a
  return {
    r: Math.round(top.r * a + bottom.r * (1 - a)),
    g: Math.round(top.g * a + bottom.g * (1 - a)),
    b: Math.round(top.b * a + bottom.b * (1 - a)),
    a: 1,
  }
}

const GREY_30 = { r: 127, g: 127, b: 127, a: 0.3 }
// 卡片底色：面板底上叠 8% 灰（.dsn-note 的 background）。
const GREY_08 = { r: 127, g: 127, b: 127, a: 0.08 }

// ---------------------------------------------------------------- 插件自己的五色
//
// 色条不在 DSH 主题 token 里，是我们自己写死的 hex（浅色压深一套、深色另一套）。
// 从 lib/client.js 的 CSS 里解析出来，这样改了色值忘改测试就会红，而不是「测试很绿、页面不达标」。
const clientSource = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const palette = { light: new Map(), dark: new Map() }
const colorPattern = /\.dsn-c-([a-z]+)\{--dsn-sticky:(#[0-9a-fA-F]{6})\}/g
const darkColorPattern = /body\[data-ds-dark-theme\]\s+\.dsn-c-([a-z]+)\{--dsn-sticky:(#[0-9a-fA-F]{6})\}/g
let colorMatch
while ((colorMatch = darkColorPattern.exec(clientSource)) !== null) {
  palette.dark.set(colorMatch[1], colorMatch[2])
}
const lightSource = clientSource.replace(/body\[data-ds-dark-theme\][^{]*\{[^}]*\}/g, '')
while ((colorMatch = colorPattern.exec(lightSource)) !== null) {
  palette.light.set(colorMatch[1], colorMatch[2])
}

// 每一行 = 我们 CSS 里真实用到的一对颜色（注释指向用法）。
const cases = [
  { label: '正文 / 面板底', fg: '--dsw-alias-label-primary', bg: '--dsw-alias-bg-layer-1', min: 4.5 },
  { label: '次要文字（时间、提示）/ 面板底', fg: '--dsw-alias-label-secondary', bg: '--dsw-alias-bg-layer-1', min: 4.5 },
  { label: '品牌按钮文字 / 品牌底色', fg: '--dsw-alias-bg-layer-1', bg: '--dsw-alias-brand-primary', min: 4.5 },
  { label: '提示条文字 / 提示条底色（品牌）', fg: '--dsw-alias-bg-layer-1', bg: '--dsw-alias-brand-primary', min: 4.5 },
  // 错误提示条现在用「面板底 + 错误色边框」：文字必须过 4.5，边框属于图形元素按 3.0 算。
  { label: '错误提示文字 / 面板底', fg: '--dsw-alias-label-primary', bg: '--dsw-alias-bg-layer-1', min: 4.5 },
  { label: '错误提示边框 / 面板底', fg: '--dsw-alias-state-error-primary', bg: '--dsw-alias-bg-layer-1', min: 3 },
  { label: '保存失败圆点 / 面板底', fg: '--dsw-alias-state-error-primary', bg: '--dsw-alias-bg-layer-1', min: 3 },
]

const failures = []
console.log('对比度（WCAG 2.2；正文 4.5，大字/图形 3.0）\n')
console.log('主题  用例                                    比值     判定')
for (const theme of ['light', 'dark']) {
  for (const item of cases) {
    const fg = resolve(item.fg, theme)
    const bg = resolve(item.bg, theme)
    if (!fg || !bg) {
      console.log(`[${theme}] ${item.label} —— 解析不到颜色，跳过`)
      continue
    }
    const ratio = contrast(fg, bg)
    const ok = ratio >= item.min
    console.log(`${theme.padEnd(5)} ${item.label.padEnd(40)} ${ratio.toFixed(2).padStart(5)}   ${ok ? '✓' : '✗'}`)
    if (!ok) failures.push(`${theme}：${item.label} = ${ratio.toFixed(3)}（需 ≥ ${item.min}）`)
  }

  // <mark> 高亮：半透明灰叠在面板底上，再与正文色比。
  const surface = resolve('--dsw-alias-bg-layer-1', theme)
  const fg = resolve('--dsw-alias-label-primary', theme)
  if (surface && fg) {
    const markBg = over(GREY_30, surface)
    const ratio = contrast(fg, markBg)
    const ok = ratio >= 4.5
    console.log(`${theme.padEnd(5)} ${'高亮片段文字 / 高亮底色'.padEnd(40)} ${ratio.toFixed(2).padStart(5)}   ${ok ? '✓' : '✗'}`)
    if (!ok) failures.push(`${theme}：高亮片段 = ${ratio.toFixed(3)}（需 ≥ 4.5）`)
  }

  // 五色色条：颜色现在承载「重要程度」，属于图形元素，按 3:1 算（WCAG 1.4.11）。
  if (surface) {
    const cardBg = over(GREY_08, surface)
    for (const [id, hex] of palette[theme]) {
      const bar = parseColor(hex)
      if (!bar) {
        failures.push(`${theme}：色条 ${id} 的色值解析不了（${hex}）`)
        continue
      }
      const ratio = contrast(bar, cardBg)
      const ok = ratio >= 3
      console.log(`${theme.padEnd(5)} ${`色条·${id} / 卡片底`.padEnd(40)} ${ratio.toFixed(2).padStart(5)}   ${ok ? '✓' : '✗'}`)
      if (!ok) failures.push(`${theme}：色条 ${id} = ${ratio.toFixed(3)}（需 ≥ 3）`)
    }
  }
}

if (failures.length > 0) {
  console.error('\nFAIL')
  for (const failure of failures) console.error(' - ' + failure)
  process.exit(1)
}
console.log('\nPASS  所有配色对都达到 WCAG AA')
