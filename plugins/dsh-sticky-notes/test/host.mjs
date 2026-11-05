// 宿主半侧单测：假 ctx / webServer / speechToText，不启动真实 Host。
//
// 覆盖语音桥的三件事：
//   1. 路由注册形态（webServer 前缀路由）与 loopback 限制；
//   2. catalog 的可用性判断（服务缺失 / provider 缺失 / 云端 / 模型未就绪）；
//   3. transcribe 的输入校验（base64、大小、WAV、时长）与成功/失败返回。
import * as host from '../lib/index.js'

const failures = []
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures.push(`${name}\n     期望：${JSON.stringify(expected)}\n     实际：${JSON.stringify(actual)}`)
}
function checkTrue(name, value, detail) {
  if (!value) failures.push(`${name}${detail ? '（' + detail + '）' : ''}`)
}

// ---------------------------------------------------------------- 假 Host

let registered = null
let lastTranscribeAudio = null
let service = null

function readyProvider(patch) {
  return Object.assign(
    { id: 'sensevoice', location: 'host-local', languages: ['auto', 'zh'], preparation: { phase: 'ready' } },
    patch || {},
  )
}

function makeService(options) {
  const opts = options || {}
  return {
    snapshot() {
      return {
        providers: [opts.provider || readyProvider()],
        selection: { providerId: opts.providerId || 'sensevoice', language: 'auto' },
      }
    },
    resolve(request) {
      return { provider: { info: { id: opts.providerId || 'sensevoice' } }, audio: request.audio, language: request.language || 'auto' }
    },
    async transcribe(spec) {
      if (opts.failTranscribe) throw new Error('model exploded')
      lastTranscribeAudio = spec.audio
      return { text: opts.text === undefined ? '这是语音识别结果' : opts.text, audioSeconds: 2, inferenceSeconds: 0.12 }
    },
  }
}

const ctx = {
  effect(callback) {
    callback()
    return function () {}
  },
  get(key) {
    return key === 'speechToText' ? service : null
  },
  webServer: {
    register(route) {
      registered = route
      return function () {}
    },
  },
}

host.apply(ctx)

check('导出 name', typeof host.name, 'string')
check('inject 了 webServer', host.inject.indexOf('webServer') !== -1, true)
check('注册了前缀路由', registered && registered.kind, 'prefix')
check('路由前缀正确', registered && registered.path, '/_dsh/dsh-sticky-notes')

// 旧版本宿主半侧是空插件：没有路由就不要再往下调 handler（报清楚，不 TypeError）。
if (!registered) {
  failures.push('没有注册任何语音路由')
  console.error('FAIL')
  for (const failure of failures) console.error(' - ' + failure)
  process.exit(1)
}

// ---------------------------------------------------------------- 请求工具

function makeReq({ method = 'GET', url = '/_dsh/dsh-sticky-notes/voice/catalog', host: hostHeader = '127.0.0.1:43129', body = null } = {}) {
  const chunks = body === null ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    method,
    url,
    headers: { host: hostHeader },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name] = value
    },
    end(body) {
      this.body = String(body || '')
    },
  }
}

async function call(options) {
  const req = makeReq(options)
  const res = makeRes()
  await registered.handler(req, res)
  let payload = null
  try {
    payload = res.body ? JSON.parse(res.body) : null
  } catch (error) {
    payload = { parseError: String(error) }
  }
  return { status: res.statusCode, headers: res.headers, json: payload }
}

/** 造一段 16kHz 单声道 PCM16 WAV：dataSeconds 秒。 */
function makeWav(dataSeconds, float = false) {
  const sampleRate = float ? 8000 : 16000
  const byteRate = float ? 1024 : 32000
  const dataSize = Math.round(dataSeconds * byteRate)
  const bytes = Buffer.alloc(44 + dataSize)
  bytes.write('RIFF', 0, 'ascii')
  bytes.writeUInt32LE(bytes.length - 8, 4)
  bytes.write('WAVE', 8, 'ascii')
  bytes.write('fmt ', 12, 'ascii')
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(sampleRate, 24)
  bytes.writeUInt32LE(byteRate, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36, 'ascii')
  bytes.writeUInt32LE(dataSize, 40)
  return bytes
}

// ---------------------------------------------------------------- catalog

service = makeService()
let result = await call()
check('服务可用时 catalog.ok', result.json && result.json.ok, true)
check('服务可用时 available', result.json.catalog.available, true)
check('catalog 带 60 秒上限', result.json.catalog.limits.maxDurationSeconds, 60)
check('catalog 带 2MB 上限', result.json.catalog.limits.maxAudioBytes, 2 * 1024 * 1024)
check('catalog 带本机 provider', result.json.catalog.location, 'host-local')

service = null
result = await call()
check('语音服务缺失时 available=false', result.json.catalog.available, false)
check('语音服务缺失时 reason=no-service', result.json.catalog.reason, 'no-service')

service = makeService({ provider: readyProvider({ location: 'cloud' }) })
result = await call()
check('云端 provider 不放行', result.json.catalog.available, false)
check('云端 provider 的 reason', result.json.catalog.reason, 'not-local')

service = makeService({ provider: readyProvider({ preparation: { phase: 'standby' } }) })
result = await call()
check('standby（模型已就绪、worker 未启动）要放行', result.json.catalog.available, true)
check('standby 不产生 reason', result.json.catalog.reason, '')

service = makeService({ provider: readyProvider({ preparation: { phase: 'waking' } }) })
result = await call()
check('waking（worker 正在拉起）要放行', result.json.catalog.available, true)

service = makeService({ provider: readyProvider({ preparation: { phase: 'downloading' } }) })
result = await call()
check('模型未就绪时不放行', result.json.catalog.available, false)
check('模型未就绪的 reason', result.json.catalog.reason, 'not-ready')

service = makeService({ providerId: 'missing' })
result = await call()
check('选中 provider 不存在时的 reason', result.json.catalog.reason, 'no-provider')

// ---------------------------------------------------------------- transcribe

service = makeService()
lastTranscribeAudio = null
const wav = makeWav(2)
result = await call({
  method: 'POST',
  url: '/_dsh/dsh-sticky-notes/voice/transcribe',
  body: { audioBase64: wav.toString('base64') },
})
check('transcribe 成功返回 ok', result.json.ok, true)
check('返回识别文本', result.json.text, '这是语音识别结果')
check('返回音频时长', result.json.audioSeconds, 2)
checkTrue('Host 收到的是 WAV 字节', lastTranscribeAudio && lastTranscribeAudio.toString('ascii', 0, 4) === 'RIFF', 'audio=' + String(lastTranscribeAudio && lastTranscribeAudio.length))

service = makeService()
result = await call({
  method: 'POST',
  url: '/_dsh/dsh-sticky-notes/voice/transcribe',
  body: { audioBase64: 'not-base64!!!' },
})
check('非法 base64 被拒', result.json.error.code, 'bad-audio')

result = await call({
  method: 'POST',
  url: '/_dsh/dsh-sticky-notes/voice/transcribe',
  body: {},
})
check('缺音频被拒', result.json.error.code, 'bad-audio')

result = await call({
  method: 'POST',
  url: '/_dsh/dsh-sticky-notes/voice/transcribe',
  body: { audioBase64: Buffer.from('hello world').toString('base64') },
})
check('非 WAV 被拒', result.json.error.code, 'bad-audio')

result = await call({
  method: 'POST',
  url: '/_dsh/dsh-sticky-notes/voice/transcribe',
  body: { audioBase64: makeWav(90, true).toString('base64') },
})
check('超过 60 秒被拒', result.json.error.code, 'too-long')

result = await call({
  method: 'POST',
  url: '/_dsh/dsh-sticky-notes/voice/transcribe',
  body: { audioBase64: Buffer.alloc(2 * 1024 * 1024 + 16).toString('base64') },
})
checkTrue('超过 2MB 被拒', result.json.ok === false, JSON.stringify(result.json))

service = makeService({ failTranscribe: true })
result = await call({
  method: 'POST',
  url: '/_dsh/dsh-sticky-notes/voice/transcribe',
  body: { audioBase64: makeWav(1).toString('base64') },
})
check('转写失败返回 transcribe-failed', result.json.error.code, 'transcribe-failed')

service = makeService({ text: '   ' })
result = await call({
  method: 'POST',
  url: '/_dsh/dsh-sticky-notes/voice/transcribe',
  body: { audioBase64: makeWav(1).toString('base64') },
})
check('空识别结果返回 empty', result.json.error.code, 'empty')

// ---------------------------------------------------------------- 边界

result = await call({ host: 'evil.example.com:43129' })
check('非 loopback Host 被拒', result.status, 403)

result = await call({ method: 'POST', url: '/_dsh/dsh-sticky-notes/nope' })
check('未知路由 404', result.status, 404)

result = await call({ method: 'POST', url: '/_dsh/dsh-sticky-notes/voice/catalog', body: {} })
check('catalog 只接受 GET', result.status, 404)

// ---------------------------------------------------------------- 结果

if (failures.length > 0) {
  console.error('FAIL')
  for (const failure of failures) console.error(' - ' + failure)
  process.exit(1)
}
console.log('PASS  宿主语音桥：路由注册 / catalog 可用性（服务缺失 / 云端 / 未就绪 / provider 缺失）/ transcribe 成功与输入校验（base64 / 非 WAV / 超时长 / 超大小）/ 失败与空结果 / loopback 与未知路由')
