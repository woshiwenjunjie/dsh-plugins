#!/usr/bin/env node
// 打包自检：把每个插件真的 `npm pack` 出来，检查「别人装上会拿到什么」。
//
// 为什么单独一层：`check.mjs` 看的是源码树，而 npm 发布看的是 tarball。
// 两者的差异（漏了 lib、test/ 混进去、icon 超限、entry id 写错）只有打包才暴露。
// 这一步离线可跑：不登录、不联网（npm pack 只读本地）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const pluginsDir = path.join(repoRoot, 'plugins')

// 市场安装后一定需要的文件；少一个就是装不上或没图标。
const REQUIRED = ['package.json', 'lib/index.js', 'lib/client.js', 'cordis.patch.yml', 'icon.svg', 'README.md', 'CHANGELOG.md']
// 绝不进包的东西。
const FORBIDDEN = [/^test\//, /(^|\/)node_modules\//, /\.tgz$/, /^\.github\//, /^scripts\//]
const ICON_LIMIT = 256 * 1024

const failures = []
function fail(plugin, message) {
  failures.push(`${plugin}: ${message}`)
}

const VERBOSE = process.argv.includes('--list')

function pack(pluginDir) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pack-'))
  // Windows 上 npm 是 .cmd，只能经 shell 调用；路径都是我们自己造的临时目录，加引号即可。
  const command = `npm pack --json --pack-destination "${dest}"`
  const result = spawnSync(command, {
    cwd: pluginDir,
    encoding: 'utf8',
    shell: true,
  })
  if (result.status !== 0) {
    return { error: (result.stderr || result.stdout || `exit ${result.status}`).trim().slice(0, 400) }
  }
  // npm 有时候会先打日志再打 JSON（我们只要最后一段 JSON）。
  const raw = result.stdout || ''
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start === -1 || end === -1) return { error: 'npm pack 没有输出 JSON：' + raw.slice(0, 200) }
  let parsed
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch (error) {
    return { error: 'npm pack JSON 解析失败：' + error.message }
  }
  const entry = Array.isArray(parsed) ? parsed[0] : parsed
  if (!entry || !Array.isArray(entry.files)) return { error: 'npm pack 结果里没有 files 列表' }
  return { entry, dest }
}

function readPackageJson(pluginDir) {
  return JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'))
}

function checkPatchEntry(plugin, pluginDir, pkg) {
  const patchPath = path.join(pluginDir, String((pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch) || 'cordis.patch.yml'))
  if (!fs.existsSync(patchPath)) {
    fail(plugin, `dsh.bundle.patch 指向的文件不存在：${path.relative(pluginDir, patchPath)}`)
    return
  }
  const text = fs.readFileSync(patchPath, 'utf8')
  // 市场用正则抓 `id:` 行并要求其后直接换行，行尾注释会被判成缺 entry ID。
  // 允许 YAML 列表写法 `- id: xxx`。
  const idLine = text.split(/\r?\n/).find((line) => /^\s*(?:-\s+)?id\s*:/.test(line))
  if (!idLine) {
    fail(plugin, 'cordis.patch.yml 里没有 id: 行')
    return
  }
  const value = idLine.replace(/^\s*(?:-\s+)?id\s*:\s*/, '').trim()
  if (!/^[A-Za-z0-9@/._-]+$/.test(value)) {
    fail(plugin, `cordis.patch.yml 的 id 行带了额外内容（市场会解析失败）：${JSON.stringify(idLine)}`)
  } else if (value !== pkg.name) {
    fail(plugin, `cordis.patch.yml 的 id（${value}）应与包名（${pkg.name}）一致`)
  }
}

const entries = fs.existsSync(pluginsDir)
  ? fs
      .readdirSync(pluginsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  : []

if (entries.length === 0) {
  console.error('plugins/ 下没有插件目录')
  process.exit(1)
}

console.log(`打包自检 ${entries.length} 个插件：${entries.join(', ')}\n`)
console.log('插件                  包体积     文件数  解包体积   结果')
for (const name of entries) {
  const pluginDir = path.join(pluginsDir, name)
  const pkg = readPackageJson(pluginDir)
  const before = failures.length

  if (pkg.private === true) fail(name, 'package.json 里有 private: true，npm 会拒绝发布')

  const packed = pack(pluginDir)
  if (packed.error) {
    fail(name, 'npm pack 失败：' + packed.error)
    console.log(`${name.padEnd(22)} —        —       —          ✗`)
    continue
  }
  const { entry, dest } = packed

  const files = entry.files.map((file) => file.path.replace(/\\/g, '/'))
  const set = new Set(files)

  for (const required of REQUIRED) {
    if (!set.has(required)) fail(name, `包内缺少必需文件：${required}`)
  }
  for (const file of files) {
    if (FORBIDDEN.some((pattern) => pattern.test(file))) fail(name, `不该进包的文件：${file}`)
  }

  // 包里的产物必须和源码一致（没有构建步骤时，这能挡住「改了源码忘了提交/忘了发布」之外的旧产物）。
  const clientInPack = entry.files.find((file) => file.path.replace(/\\/g, '/') === 'lib/client.js')
  const clientOnDisk = path.join(pluginDir, 'lib', 'client.js')
  if (clientInPack && fs.existsSync(clientOnDisk)) {
    if (clientInPack.size !== fs.statSync(clientOnDisk).size) {
      fail(name, `包内 lib/client.js（${clientInPack.size}B）与源码（${fs.statSync(clientOnDisk).size}B）大小不一致`)
    }
  }

  const iconRel = typeof pkg.icon === 'string' ? pkg.icon.replace(/^\.\//, '') : 'icon.svg'
  const iconInPack = entry.files.find((file) => file.path.replace(/\\/g, '/') === iconRel)
  if (!iconInPack) fail(name, `包内缺少 icon：${iconRel}`)
  else if (iconInPack.size > ICON_LIMIT) fail(name, `icon 超过 256KiB 上限：${iconInPack.size}B`)

  checkPatchEntry(name, pluginDir, pkg)

  const ok = failures.length === before
  console.log(
    `${name.padEnd(22)} ${(entry.size / 1024).toFixed(1).padStart(6)}KiB ${String(files.length).padStart(7)}  ${((entry.unpackedSize || 0) / 1024).toFixed(1).padStart(7)}KiB   ${ok ? '✓' : '✗'}`,
  )
  if (VERBOSE) for (const file of files) console.log('    ' + file)

  // 顺手验证「解出来真的能用」：解包后确认 exports 指向的文件存在。
  if (ok) {
    const outDir = path.join(dest, 'unpacked')
    fs.mkdirSync(outDir, { recursive: true })
    const tgz = path.join(dest, entry.filename || '')
    const untar = spawnSync(`tar -xzf "${tgz}" -C "${outDir}"`, { encoding: 'utf8', shell: true })
    if (untar.status !== 0) {
      fail(name, '解包失败：' + String(untar.stderr || '').trim().slice(0, 200))
    } else {
      const root = path.join(outDir, 'package')
      const clientRel = String((pkg.exports && pkg.exports['./client']) || './lib/client.js').replace(/^\.\//, '')
      for (const rel of ['package.json', clientRel]) {
        if (!fs.existsSync(path.join(root, rel))) fail(name, `解包后缺少 ${rel}`)
      }
      const packedPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
      if (packedPkg.version !== pkg.version) fail(name, '解包后的 version 与源码不一致')
      if (!packedPkg.dsh || !packedPkg.dsh.bundle) fail(name, '解包后的 package.json 丢了 dsh.bundle 声明')
    }
  }
}

if (failures.length > 0) {
  console.error('\n✗ 打包自检未通过：')
  for (const failure of failures) console.error('  - ' + failure)
  process.exit(1)
}
console.log('\n全部通过：包里该有的都有，不该有的一件没混进去')
