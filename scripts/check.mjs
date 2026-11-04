#!/usr/bin/env node
// 全仓库校验：遍历 plugins/*，对每个插件做
//   1) package.json 结构检查（bundle patch / client 导出 / 图标 / 版本号）
//   2) lib/client.js 语法检查（vm 只编译不执行，不会碰 window）
//   3) 跑 test/ 下的测试（smoke 必须有；behavior 等行为测试存在就跑）
// 零依赖，`node scripts/check.mjs` 即可，CI 与本地同一套。
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const pluginsDir = path.join(repoRoot, 'plugins')

const failures = []
let checked = 0

function fail(plugin, message) {
  failures.push(`${plugin}: ${message}`)
}

function isSemver(version) {
  return typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)
}

function checkPlugin(dirName) {
  const pluginDir = path.join(pluginsDir, dirName)
  const pkgPath = path.join(pluginDir, 'package.json')
  if (!fs.existsSync(pkgPath)) {
    fail(dirName, '缺少 package.json')
    return
  }

  let pkg
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  } catch (error) {
    fail(dirName, 'package.json 解析失败：' + error.message)
    return
  }

  if (pkg.name !== dirName) fail(dirName, `package.json 的 name（${pkg.name}）应与目录名一致`)
  if (!isSemver(pkg.version)) fail(dirName, 'version 不是合法 semver：' + pkg.version)
  if (!pkg.dsh || !pkg.dsh.bundle || typeof pkg.dsh.bundle.patch !== 'string') {
    fail(dirName, '缺少 dsh.bundle.patch 声明')
  } else if (!fs.existsSync(path.join(pluginDir, pkg.dsh.bundle.patch))) {
    fail(dirName, 'dsh.bundle.patch 指向的文件不存在：' + pkg.dsh.bundle.patch)
  }
  if (!pkg.dsh || !pkg.dsh.client || pkg.dsh.client.platform !== 'web') {
    fail(dirName, '缺少 dsh.client.platform = "web" 声明')
  }
  if (!pkg.exports || !pkg.exports['./client']) fail(dirName, '缺少 exports["./client"]')

  const mainFile = path.join(pluginDir, pkg.main || 'lib/index.js')
  if (!fs.existsSync(mainFile)) fail(dirName, 'main 指向的文件不存在：' + (pkg.main || 'lib/index.js'))

  const clientFile = pkg.exports && pkg.exports['./client']
    ? path.join(pluginDir, String(pkg.exports['./client']).replace(/^\.\//, ''))
    : path.join(pluginDir, 'lib/client.js')
  if (!fs.existsSync(clientFile)) {
    fail(dirName, 'client bundle 不存在：' + path.relative(pluginDir, clientFile))
  } else {
    // 只编译、不执行：client.js 顶层会读 window，直接跑会炸。
    try {
      new vm.Script(fs.readFileSync(clientFile, 'utf8'), { filename: clientFile })
    } catch (error) {
      fail(dirName, 'client bundle 语法错误：' + error.message)
    }
  }

  const smoke = path.join(pluginDir, 'test', 'smoke.mjs')
  if (!fs.existsSync(smoke)) {
    fail(dirName, '缺少 test/smoke.mjs（每个插件都要有冒烟测试）')
    return
  }
  for (const testName of ['smoke.mjs', 'behavior.mjs']) {
    const testFile = path.join(pluginDir, 'test', testName)
    if (!fs.existsSync(testFile)) continue
    const result = spawnSync(process.execPath, [testFile], { stdio: 'inherit', cwd: pluginDir })
    if (result.status !== 0) fail(dirName, `${testName} 失败（exit ${result.status}）`)
  }

  checked += 1
  console.log(`\n✓ ${dirName} — 通过\n`)
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

console.log(`检查 ${entries.length} 个插件：${entries.join(', ')}\n`)
for (const name of entries) checkPlugin(name)

if (failures.length > 0) {
  console.error('\n✗ 校验未通过：')
  for (const failure of failures) console.error('  - ' + failure)
  process.exit(1)
}

console.log(`\n全部通过：${checked}/${entries.length} 个插件`)
