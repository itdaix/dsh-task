/**
 * dsh-task Host half（MVP）。
 *
 * 只 import node 内置：link 安装到 profile 后，@deepseek-ai/* 说明符从真实
 * 路径解析不到，一切所需服务都从 Cordis 上下文取。
 *
 * 职责：自写 CRON（5 段 + 可选第 6 段秒）、1 秒心跳调度、overlap 重入锁
 * （skip/allow/queue）、向指定 SESSION 投递提示词并等 turn 结束、JSONL 日志、
 * 以及读写 config.json 的 RPC（connection.fetch.register + /api/dsh-task）。
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, appendFileSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-task'

export const inject = [
  'connection',
  'sessionController',
  'sessions',
  'workspaceRegistry',
]

// ---- 路径：import.meta.url 推导，link 后仍是真实路径 ----
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = join(PLUGIN_DIR, 'config.json')
const LOG_DIR = join(PLUGIN_DIR, '.log')

const OVERLAPS = ['skip', 'allow', 'queue']
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const MAX_LOG_CHARS = 1024 * 1024

// ============================ CRON ============================

function parseCronField(field, min, max, aliases) {
  if (typeof field !== 'string' || field.trim() === '') throw new Error('empty cron field')
  if (aliases !== undefined) {
    const lower = field.toLowerCase()
    if (aliases[lower] !== undefined) field = String(aliases[lower])
  }
  const values = new Set()
  for (const part of field.split(',')) {
    const stepMatch = /^(\*|\d+(-\d+)?)\/(\d+)$/.exec(part)
    let range = part
    let step = 1
    if (stepMatch !== null) {
      range = stepMatch[1]
      step = Number(stepMatch[3])
      if (step < 1) throw new Error(`cron step must be >= 1: ${part}`)
    }
    let lo
    let hi
    if (range === '*') {
      lo = min
      hi = max
    } else if (/^\d+$/.test(range)) {
      lo = hi = Number(range)
    } else {
      const m = /^(\d+)-(\d+)$/.exec(range)
      if (m === null) throw new Error(`invalid cron field part: ${part}`)
      lo = Number(m[1])
      hi = Number(m[2])
    }
    if (lo < min || hi > max || lo > hi) {
      throw new Error(`cron field out of range [${min},${max}]: ${part}`)
    }
    for (let v = lo; v <= hi; v += step) values.add(v)
  }
  return values
}

const WEEK_ALIASES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }
const MONTH_ALIASES = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }

/**
 * 解析 CRON：5 段（分 时 日 月 周）或 6 段（秒 分 时 日 月 周）。
 * 返回 { second?, minute, hour, day, month, week, dayWild, weekWild }。
 */
export function parseCron(expr) {
  if (typeof expr !== 'string' || expr.trim() === '') throw new Error('cron is empty')
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5 && parts.length !== 6) {
    throw new Error(`cron must have 5 or 6 fields, got ${parts.length}: "${expr}"`)
  }
  let i = 0
  const second = parts.length === 6 ? parseCronField(parts[i++], 0, 59) : undefined
  const minute = parseCronField(parts[i++], 0, 59)
  const hour = parseCronField(parts[i++], 0, 23)
  const day = parseCronField(parts[i++], 1, 31)
  const month = parseCronField(parts[i++], 1, 12, MONTH_ALIASES)
  const week = parseCronField(parts[i++], 0, 7, WEEK_ALIASES)
  if (week.has(7)) { week.delete(7); week.add(0) }
  return {
    second,
    minute,
    hour,
    day,
    month,
    week,
    dayWild: parts[3].trim() === '*',
    weekWild: parts[4].trim() === '*',
  }
}

function hits(set, value) {
  return set === undefined || set.has(value)
}

/** 某时间是否命中 cron。 */
export function cronMatches(parsed, date) {
  if (!hits(parsed.second, date.getSeconds())) return false
  if (!hits(parsed.minute, date.getMinutes())) return false
  if (!hits(parsed.hour, date.getHours())) return false
  if (!hits(parsed.month, date.getMonth() + 1)) return false
  const dayHit = hits(parsed.day, date.getDate())
  const weekHit = hits(parsed.week, date.getDay())
  if (!parsed.dayWild && !parsed.weekWild) return dayHit || weekHit
  if (!parsed.dayWild) return dayHit
  if (!parsed.weekWild) return weekHit
  return true
}

// ============================ 配置 ============================

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return { tasks: [] }
  const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  const tasks = Array.isArray(raw?.tasks) ? raw.tasks : []
  return { tasks }
}

function saveConfig(tasks) {
  writeFileSync(CONFIG_PATH, `${JSON.stringify({ tasks }, null, 2)}\n`, 'utf8')
}

function validateTasks(raw) {
  if (!Array.isArray(raw)) throw new Error('tasks must be an array')
  const seen = new Set()
  const tasks = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('each task must be an object')
    }
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    if (id === '') throw new Error('task id is required')
    if (seen.has(id)) throw new Error(`duplicate task id: ${id}`)
    seen.add(id)
    const cron = typeof item.cron === 'string' ? item.cron.trim() : ''
    if (cron === '') throw new Error(`task ${id}: cron is required`)
    parseCron(cron)
    const overlap = item.overlap ?? 'skip'
    if (!OVERLAPS.includes(overlap)) {
      throw new Error(`task ${id}: overlap must be one of ${OVERLAPS.join('/')}`)
    }
    tasks.push({
      id,
      enabled: item.enabled !== false,
      description: typeof item.description === 'string' ? item.description : '',
      sessionId: typeof item.sessionId === 'string' ? item.sessionId : '',
      prompt: typeof item.prompt === 'string' ? item.prompt : '',
      cron,
      overlap,
    })
  }
  return tasks
}

// ============================ 日志 ============================

function pad(n) {
  return String(n).padStart(2, '0')
}

/** 本地时间 ISO 字符串（带时区偏移，如 +08:00），替代 toISOString 的 UTC。 */
function localIso(date) {
  const tz = -date.getTimezoneOffset()
  const sign = tz >= 0 ? '+' : '-'
  const abs = Math.abs(tz)
  const tzStr = sign + pad(Math.floor(abs / 60)) + ':' + pad(abs % 60)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T`
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `.${String(date.getMilliseconds()).padStart(3, '0')}${tzStr}`
}

function writeLog(record) {
  const d = new Date()
  const file = join(LOG_DIR, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.jsonl`)
  mkdirSync(LOG_DIR, { recursive: true })
  let line = JSON.stringify(record)
  if (line.length > MAX_LOG_CHARS) {
    record.truncated = true
    record.result = `${String(record.result ?? '').slice(0, MAX_LOG_CHARS)}\u2026(truncated)`
    line = JSON.stringify(record)
  }
  appendFileSync(file, `${line}\n`, 'utf8')
}

/** 读取某任务（或全部）的日志，按时间倒序，最多 limit 条。 */
function readLogs(taskId, limit) {
  const records = []
  if (!existsSync(LOG_DIR)) return records
  const files = readdirSync(LOG_DIR).filter((f) => f.endsWith('.jsonl')).sort().reverse()
  for (const file of files) {
    const lines = readFileSync(join(LOG_DIR, file), 'utf8').split('\n')
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i].trim()
      if (line === '') continue
      try {
        const rec = JSON.parse(line)
        if (taskId === undefined || rec.taskId === taskId) records.push(rec)
      } catch { /* skip malformed line */ }
    }
  }
  // 按触发时间 ts 倒序（completed 在 turn 结束才写，文件写入顺序≠触发顺序）
  records.sort((a, b) => {
    const ta = typeof a.ts === 'string' ? a.ts : ''
    const tb = typeof b.ts === 'string' ? b.ts : ''
    if (ta > tb) return -1
    if (ta < tb) return 1
    return 0
  })
  return records.slice(0, limit)
}

// ============================ 投递 ============================

function createHumanMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

function joinAssistantText(parts) {
  return parts.filter((part) => part.trim() !== '').join('\n\n')
}

/** 等一次投递被 turn 认领并结束，收 assistant 文本。 */
function waitForTurn(ctx, sessionId, messageId, timeoutMs) {
  return new Promise((resolve) => {
    let turn
    let settled = false
    const parts = []
    const disposers = []
    let timer

    const finish = (outcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      for (const dispose of disposers) {
        try { dispose() } catch { /* already torn down */ }
      }
      resolve(outcome)
    }

    const listen = (event, listener) => {
      const dispose = ctx.on(event, listener)
      if (typeof dispose === 'function') disposers.push(dispose)
    }

    timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()

    listen('agent/inbox/claimed', (payload) => {
      if (payload?.agent?.id !== sessionId) return
      if (payload?.message?.id !== messageId) return
      turn = payload.turn
    })

    listen('agent/inbox/discarded', (payload) => {
      if (payload?.message?.id !== messageId) return
      finish({ kind: 'discarded' })
    })

    listen('session/event', (session, event) => {
      if (session?.id !== sessionId) return
      if (event?.type === 'assistant/message') {
        if (turn === undefined || event.data.turn !== turn) return
        for (const block of event.data.message?.content ?? []) {
          if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
        }
        return
      }
      if (event?.type !== 'turn/end') return
      if (turn === undefined || event.data.turn !== turn) return
      finish({ kind: 'ended', turn, reason: event.data.reason, text: joinAssistantText(parts) })
    })
  })
}

function describeTurnEnd(reason) {
  const kind = reason?.kind ?? 'unknown'
  if (kind === 'completed') return { code: 'completed', message: 'Turn completed.' }
  if (kind === 'aborted') return { code: 'aborted', message: `Turn was aborted (${reason?.reason?.kind ?? 'unknown'}).` }
  if (kind === 'error') return { code: 'error', message: reason?.error?.message ?? 'Turn failed.' }
  if (kind === 'max-tokens') return { code: 'max-tokens', message: 'Turn stopped at the output-token cap.' }
  if (kind === 'blocked') return { code: 'blocked', message: 'Turn was blocked.' }
  if (kind === 'interrupted') return { code: 'interrupted', message: 'Turn was interrupted.' }
  return { code: String(kind), message: `Turn ended with reason "${String(kind)}".` }
}

const NO_ABORT = new AbortController().signal

function titleOfSummary(item) {
  const projected = item?.projections?.values?.title
  return typeof projected === 'string' && projected !== '' ? projected : null
}

function displayTitleOf(title, cwd, sessionId) {
  if (title !== null) return title
  if (typeof cwd === 'string' && cwd !== '') {
    const base = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
    if (base !== undefined && base !== '') return base
  }
  return sessionId
}

// ============================ apply ============================

export function apply(ctx, config = {}) {
  const cfg = {
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    logSkipped: config.logSkipped ?? true,
  }
  const log = ctx.logger

  let tasks = []
  let timer = null
  const cronCache = new Map()
  const running = new Map()
  const lastFired = new Map()

  function rebuildTasks(nextTasks) {
    tasks = nextTasks
    cronCache.clear()
    for (const task of tasks) {
      try {
        cronCache.set(task.id, parseCron(task.cron))
      } catch { /* validateTasks 已校验，此处不应失败 */ }
    }
  }

  rebuildTasks(loadConfig().tasks)
  log?.info?.(`dsh-task: loaded ${tasks.length} task(s)`)

  function fireKey(task, parsed, now) {
    if (parsed.second !== undefined) return null // 秒级精确，无需去重
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
  }

  async function runTurn(task, triggeredAt) {
    const startedAt = Date.now()
    const base = {
      ts: localIso(triggeredAt),
      taskId: task.id,
      description: task.description,
      sessionId: task.sessionId,
      cron: task.cron,
      startedAt: localIso(new Date(startedAt)),
      prompt: task.prompt,
    }

    let resolved
    try {
      resolved = await ctx.sessionController.resolveAgent(task.sessionId)
    } catch (error) {
      writeLog({ ...base, status: 'error', completed: false, error: String(error?.message ?? error), durationMs: Date.now() - startedAt })
      log?.error?.(`dsh-task: task ${task.id} resolveAgent failed: ${error}`)
      return
    }
    if (resolved?.error !== undefined || resolved?.agent === undefined) {
      const msg = resolved?.error?.message ?? `session not found: ${task.sessionId}`
      writeLog({ ...base, status: 'error', completed: false, reason: 'session-not-found', error: msg, durationMs: Date.now() - startedAt })
      log?.error?.(`dsh-task: task ${task.id} session not found: ${task.sessionId}`)
      return
    }
    const agent = resolved.agent

    // 权限沿用该 SESSION 在 GUI 中的既有配置，插件不覆盖。
    const message = createHumanMessage(task.prompt)
    const pending = waitForTurn(ctx, task.sessionId, message.id, cfg.timeoutMs)
    try {
      agent.followup(message)
    } catch (error) {
      writeLog({ ...base, status: 'error', completed: false, error: String(error?.message ?? error), durationMs: Date.now() - startedAt })
      log?.error?.(`dsh-task: task ${task.id} followup failed: ${error}`)
      return
    }

    const outcome = await pending
    if (outcome.kind === 'timeout') {
      writeLog({ ...base, status: 'timeout', completed: false, error: `no turn completed within ${cfg.timeoutMs}ms`, durationMs: Date.now() - startedAt })
      return
    }
    if (outcome.kind === 'discarded') {
      writeLog({ ...base, status: 'discarded', completed: false, error: 'message discarded before it ran', durationMs: Date.now() - startedAt })
      return
    }
    const described = describeTurnEnd(outcome.reason)
    writeLog({
      ...base,
      status: described.code,
      completed: described.code === 'completed',
      durationMs: Date.now() - startedAt,
      endedAt: localIso(new Date()),
      result: outcome.text,
      turn: outcome.turn,
      error: described.code === 'completed' ? null : described.message,
    })
    log?.info?.(`dsh-task: task ${task.id} ${described.code} in ${Date.now() - startedAt}ms`)
  }

  async function fire(task, now) {
    const lock = running.get(task.id)
    if (lock !== undefined) {
      if (task.overlap === 'skip') {
        if (cfg.logSkipped) {
          writeLog({
            ts: localIso(now), taskId: task.id, description: task.description,
            sessionId: task.sessionId, cron: task.cron, status: 'skipped', completed: false,
            prompt: task.prompt,
            reason: 'running', runningSince: localIso(new Date(lock.startedAt)),
          })
        }
        return
      }
      if (task.overlap === 'queue') {
        lock.queued += 1
        return
      }
      // allow：并发独立跑
      try { await runTurn(task, now) } catch (error) { log?.error?.(`dsh-task: task ${task.id} run error: ${error}`) }
      return
    }

    const entry = { startedAt: Date.now(), queued: 0 }
    running.set(task.id, entry)
    try {
      let at = now
      while (true) {
        try { await runTurn(task, at) } catch (error) { log?.error?.(`dsh-task: task ${task.id} run error: ${error}`) }
        if (entry.queued > 0) {
          entry.queued -= 1
          at = new Date()
          continue
        }
        break
      }
    } finally {
      running.delete(task.id)
    }
  }

  function tick() {
    const now = new Date()
    for (const task of tasks) {
      if (task.enabled !== true) continue
      const parsed = cronCache.get(task.id)
      if (parsed === undefined) continue
      if (!cronMatches(parsed, now)) continue
      const key = fireKey(task, parsed, now)
      if (key !== null) {
        if (lastFired.get(task.id) === key) continue
        lastFired.set(task.id, key)
      }
      void fire(task, now)
    }
  }

  function rebuildScheduler() {
    if (timer !== null) { clearInterval(timer); timer = null }
    lastFired.clear()
    if (tasks.length === 0) return
    timer = setInterval(tick, 1000)
    if (typeof timer.unref === 'function') timer.unref()
  }

  // ---- RPC ----
  const ENDPOINT = 'dsh-task'

  function reply(rpcId, result) {
    const value = result.ok === false
      ? { ...result, error: { ...result.error, details: result.error.details ?? {} } }
      : result
    return Response.json({ type: 'server-response', rpcId, result: value })
  }

  function isRecord(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v)
  }

  async function handleRpc(method, payload) {
    if (method === 'get') {
      // 附带每个任务最近一次执行（读日志，ts 倒序取首条）
      const lastByTask = new Map()
      for (const rec of readLogs(undefined, 2000)) {
        if (!lastByTask.has(rec.taskId)) lastByTask.set(rec.taskId, rec)
      }
      const enriched = tasks.map((task) => {
        const last = lastByTask.get(task.id)
        return {
          ...task,
          lastRunAt: typeof last?.ts === 'string' ? last.ts : null,
          lastStatus: typeof last?.status === 'string' ? last.status : null,
          lastDurationMs: Number.isFinite(last?.durationMs) ? last.durationMs : null,
        }
      })
      return { ok: true, value: { tasks: enriched } }
    }
    if (method === 'sessions') {
      try {
        const { items } = await ctx.sessionController.list({}, NO_ABORT)
        const bySession = new Map()
        for (const ws of ctx.workspaceRegistry.list()) {
          for (const sid of ws.sessionIds) bySession.set(sid, ws)
        }
        const archived = new Set(ctx.workspaceRegistry.archivedSessionIds ?? [])
        const out = []
        for (const item of items) {
          if (item.origin === 'subagent') continue
          if (archived.has(item.sessionId)) continue
          const ws = bySession.get(item.sessionId)
          const title = titleOfSummary(item)
          const desc = displayTitleOf(title, item.cwd, item.sessionId)
          const wsName = ws?.title !== undefined && ws.title !== ''
            ? ws.title
            : (ws?.path !== undefined ? basename(ws.path) : basename(item.cwd ?? ''))
          out.push({
            sessionId: item.sessionId,
            updatedAt: item.updatedAt,
            displayTitle: wsName !== '' ? `${wsName} - ${desc}` : desc,
          })
        }
        out.sort((a, b) => b.updatedAt - a.updatedAt)
        return { ok: true, value: { sessions: out.map(({ sessionId, displayTitle }) => ({ sessionId, displayTitle })) } }
      } catch (error) {
        return { ok: false, error: { code: 'sessions-error', message: String(error?.message ?? error), details: {} } }
      }
    }
    if (method === 'logs') {
      const taskId = typeof payload?.taskId === 'string' ? payload.taskId : undefined
      const limit = Number.isSafeInteger(payload?.limit) && payload.limit > 0 ? payload.limit : 200
      try {
        return { ok: true, value: { logs: readLogs(taskId, limit) } }
      } catch (error) {
        return { ok: false, error: { code: 'logs-error', message: String(error?.message ?? error), details: {} } }
      }
    }
    if (method === 'set') {
      const next = validateTasks(payload?.tasks)
      rebuildTasks(next)
      saveConfig(next)
      rebuildScheduler()
      log?.info?.(`dsh-task: saved ${next.length} task(s)`)
      return { ok: true, value: { tasks } }
    }
    if (method === 'run') {
      const taskId = payload?.taskId
      const task = tasks.find((t) => t.id === taskId)
      if (task === undefined) {
        return { ok: false, error: { code: 'task-not-found', message: `task not found: ${taskId}`, details: {} } }
      }
      void fire(task, new Date())
      log?.info?.(`dsh-task: debug run for task ${taskId}`)
      return { ok: true, value: { triggered: true } }
    }
    return { ok: false, error: { code: 'bad-method', message: `unknown method ${method}`, details: {} } }
  }

  ctx.effect(() => ctx.connection.fetch.register({
    path: `/api/${ENDPOINT}`,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
      const ct = (request.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase()
      if (ct !== 'application/json') return new Response('content type must be application/json', { status: 415 })
      let message
      try { message = await request.json() } catch { return new Response('body is not JSON', { status: 400 }) }
      const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request'
      const call = message?.payload
      if (!isRecord(message) || message.type !== 'client-request' || typeof message.rpcId !== 'string'
        || message.method !== ENDPOINT || !isRecord(call) || typeof call.method !== 'string'
        || !Object.hasOwn(call, 'payload')) {
        return reply(rpcId, { ok: false, error: { code: 'gateway/bad-request', message: 'Invalid dsh-task request.', details: {} } })
      }
      try {
        return reply(rpcId, await handleRpc(call.method, call.payload))
      } catch (error) {
        return reply(rpcId, { ok: false, error: { code: 'bad-request', message: String(error?.message ?? error), details: {} } })
      }
    },
  }), 'dsh-task: /api/dsh-task rpc')

  // ---- 生命周期 ----
  rebuildScheduler()
  ctx.effect(() => () => { if (timer !== null) clearInterval(timer) }, 'dsh-task: scheduler cleanup')
}
