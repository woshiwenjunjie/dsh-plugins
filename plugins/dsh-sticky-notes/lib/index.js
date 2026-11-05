/**
 * 宿主半侧：语音转写的同源 HTTP 桥。
 *
 * 便签数据全部存在浏览器 localStorage，所以这里原本什么都不用做。
 * 语音输入需要复用 DSH 的 speechToText 服务（本机 SenseVoice，不上报、不联网），
 * 而第三方客户端插件没有 ctx.remote.speech 的现成先例，所以按 dsh-prompt 的先例
 * 走同源 HTTP 桥：
 *
 *   GET  /_dsh/dsh-sticky-notes/voice/catalog     → 服务是否可用 / 上限 / 语言
 *   POST /_dsh/dsh-sticky-notes/voice/transcribe  → { audioBase64 } → { text }
 *
 * 音频只在内存里走一趟：不写盘、不记日志内容、不进 localStorage。
 * @module dsh-sticky-notes
 */

export const name = 'dsh-sticky-notes'

// webServer 是 web profile 的核心服务，注入它才能在 Host 侧挂路由。
export const inject = ['webServer']

const PREFIX = '/_dsh/dsh-sticky-notes'

/** 插件自定的录音上限（Host 服务允许 120s / 4MB，便签不需要那么长）。 */
const LIMITS = {
  maxAudioBytes: 2 * 1024 * 1024,
  maxDurationSeconds: 60,
}

/** transcribe 请求体上限：base64 比原音频大 4/3，再留一点 JSON 余量。 */
const MAX_BODY_BYTES = Math.ceil(LIMITS.maxAudioBytes / 3) * 4 + 64 * 1024

const MIME_JSON = 'application/json; charset=utf-8'

export function apply(ctx) {
  ctx.effect(function () {
    return ctx.webServer.register(buildRoute(ctx))
  }, 'dsh-sticky-notes: voice bridge')
}

// ------------------------------------------------------------------ 路由

function buildRoute(ctx) {
  async function handler(req, res) {
    const method = String((req && req.method) || 'GET').toUpperCase()
    const pathname = pathnameOf(req && req.url)
    if (!pathname || pathname.indexOf(PREFIX) !== 0) return notFound(res)
    // 同源桥只给本机 GUI 用：Host 头必须是 loopback，避免局域网/恶意页面触达。
    if (!isLoopbackHost(req && req.headers && req.headers.host)) {
      return json(res, 403, { ok: false, error: { code: 'forbidden', message: 'loopback only' } })
    }

    if (method === 'GET' && pathname === PREFIX + '/voice/catalog') return catalog(ctx, res)
    if (method === 'POST' && pathname === PREFIX + '/voice/transcribe') return transcribe(ctx, req, res)
    return notFound(res)
  }
  return { kind: 'prefix', path: PREFIX, handler }
}

function pathnameOf(rawUrl) {
  try {
    return new URL(String(rawUrl || '/'), 'http://127.0.0.1').pathname
  } catch (error) {
    return ''
  }
}

// ------------------------------------------------------------------ 语音

function speechServiceOf(ctx) {
  try {
    return typeof ctx.get === 'function' ? ctx.get('speechToText') : null
  } catch (error) {
    return null
  }
}

/**
 * 读出「能不能录」：服务存在、选中的 provider 在、provider 是本机的、且模型已就绪。
 * 不在面板里触发下载（provider 未就绪只返回 not-ready，让客户端显示说明）。
 */
function catalog(ctx, res) {
  const service = speechServiceOf(ctx)
  if (!service || typeof service.resolve !== 'function' || typeof service.transcribe !== 'function') {
    return json(res, 200, {
      ok: true,
      catalog: { available: false, reason: 'no-service', limits: LIMITS },
    })
  }
  let snapshot = null
  try {
    snapshot = typeof service.snapshot === 'function' ? service.snapshot() : null
  } catch (error) {
    snapshot = null
  }
  const selection = (snapshot && snapshot.selection) || {}
  const providers = (snapshot && Array.isArray(snapshot.providers) && snapshot.providers) || []
  const providerId = selection.providerId || ''
  const provider = providers.find(function (item) {
    return item && item.id === providerId
  })
  const preparation = (provider && provider.preparation && provider.preparation.phase) || ''
  let reason = ''
  if (!provider) reason = 'no-provider'
  else if (provider.location !== 'host-local') reason = 'not-local'
  else if (preparation && preparation !== 'ready') reason = 'not-ready'
  return json(res, 200, {
    ok: true,
    catalog: {
      available: !reason,
      reason: reason,
      providerId: providerId,
      location: (provider && provider.location) || '',
      preparation: preparation,
      language: selection.language || 'auto',
      limits: LIMITS,
    },
  })
}

async function transcribe(ctx, req, res) {
  const service = speechServiceOf(ctx)
  if (!service || typeof service.resolve !== 'function' || typeof service.transcribe !== 'function') {
    return fail(res, 200, 'no-service', 'speech service is not available')
  }
  let body
  try {
    body = await readJsonBody(req, MAX_BODY_BYTES)
  } catch (error) {
    return fail(res, error && error.code === 'too-large' ? 413 : 400, error && error.code === 'too-large' ? 'too-long' : 'bad-audio', 'invalid request body')
  }
  const encoded = body && body.audioBase64
  if (typeof encoded !== 'string' || !encoded) return fail(res, 400, 'bad-audio', 'missing audio')
  // 先用长度粗判，避免把超大字符串解码进内存。
  if (encoded.length > Math.ceil(LIMITS.maxAudioBytes / 3) * 4) return fail(res, 413, 'too-long', 'audio exceeds limit')
  let audio
  try {
    audio = Buffer.from(encoded, 'base64')
    if (audio.toString('base64') !== encoded) throw new Error('non-canonical base64')
  } catch (error) {
    return fail(res, 400, 'bad-audio', 'invalid base64')
  }
  if (audio.length > LIMITS.maxAudioBytes) return fail(res, 413, 'too-long', 'audio exceeds limit')
  const seconds = wavDurationSeconds(audio)
  if (seconds === null) return fail(res, 400, 'bad-audio', 'not a valid wav')
  if (seconds > LIMITS.maxDurationSeconds + 1) return fail(res, 413, 'too-long', 'audio exceeds duration limit')

  try {
    const request = { audio: audio }
    if (typeof body.providerId === 'string' && body.providerId) request.providerId = body.providerId
    if (typeof body.language === 'string' && body.language && body.language !== 'auto') request.language = body.language
    const spec = service.resolve(request)
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(120000)
      : new AbortController().signal
    const result = await service.transcribe(spec, signal)
    const text = String((result && result.text) || '').trim()
    if (!text) return fail(res, 200, 'empty', 'empty transcript')
    return json(res, 200, {
      ok: true,
      text: text,
      audioSeconds: typeof result.audioSeconds === 'number' ? result.audioSeconds : seconds,
      inferenceSeconds: typeof result.inferenceSeconds === 'number' ? result.inferenceSeconds : 0,
    })
  } catch (error) {
    return fail(res, 200, 'transcribe-failed', String((error && error.message) || error))
  }
}

// ------------------------------------------------------------------ 工具

/** 读 JSON 请求体，带字节上限（Host 的 req 是 AsyncIterable）。 */
async function readJsonBody(req, maxBytes) {
  if (!req || typeof req[Symbol.asyncIterator] !== 'function') {
    throw Object.assign(new Error('request is not readable'), { code: 'bad-request' })
  }
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw Object.assign(new Error('body too large'), { code: 'too-large' })
    chunks.push(buffer)
  }
  if (size === 0) return null
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (error) {
    throw Object.assign(new Error('invalid json'), { code: 'bad-json' })
  }
}

/**
 * 读我们自己的 WAV 编码器产出的 PCM16 单声道 16kHz 时长。
 * 只认标准 44 字节头（官方客户端与插件客户端都是这个格式），认不出返回 null。
 */
function wavDurationSeconds(bytes) {
  if (!bytes || bytes.length < 44) return null
  if (bytes.toString('ascii', 0, 4) !== 'RIFF') return null
  if (bytes.toString('ascii', 8, 12) !== 'WAVE') return null
  if (bytes.toString('ascii', 36, 40) !== 'data') return null
  const byteRate = bytes.readUInt32LE(28)
  const dataSize = bytes.readUInt32LE(40)
  if (!byteRate || !dataSize) return null
  if (44 + dataSize > bytes.length) return null
  return dataSize / byteRate
}

/** Host 头必须是 loopback（127.0.0.1 / localhost / ::1），端口先剥掉。 */
function isLoopbackHost(hostHeader) {
  const raw = String(hostHeader || '').trim().toLowerCase()
  if (!raw) return false
  let host = raw
  if (raw.charAt(0) === '[') {
    const end = raw.indexOf(']')
    if (end < 0) return false
    host = raw.slice(1, end)
  } else if (raw.indexOf(':') === raw.lastIndexOf(':')) {
    const colon = raw.lastIndexOf(':')
    if (colon > 0) host = raw.slice(0, colon)
  }
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

function json(res, status, value) {
  if (!res) return
  const body = JSON.stringify(value)
  res.statusCode = status
  if (typeof res.setHeader === 'function') {
    res.setHeader('content-type', MIME_JSON)
    res.setHeader('cache-control', 'no-store')
  }
  res.end(body)
}

function notFound(res) {
  return json(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown endpoint' } })
}

function fail(res, status, code, message) {
  return json(res, status, { ok: false, error: { code: code, message: message } })
}
