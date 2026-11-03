/**
 * 浏览器半用的 HTTP 路由。
 *
 * 跟进清单：list / add / update / remove
 * 对话状态：sessions（未收尾）、session（解析绑定）、bind、end-session
 * 项目台账：projects、mark
 *
 * 全部同源 JSON，没有 SSE——本地单人使用，客户端定时拉一次就够。
 *
 * @module dsh-followup/lib/routes
 */

import { parseDue } from './dates.js'
import { channelState, latestRelease, releaseInfo } from './projects.js'

const ROUTE_PREFIX = '/followup'
const MAX_BODY = 64 * 1024

/** 发 JSON。 */
function send(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** 成功信封。 */
function ok(res, value) {
  send(res, 200, { ok: true, value })
}

/** 失败信封。 */
function fail(res, status, code, message) {
  send(res, status, { ok: false, error: { code, message } })
}

/** 读 JSON 请求体（有上限）。 */
async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw Object.assign(new Error('body too large'), { code: 'too_large' })
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) return {}
  try {
    const value = JSON.parse(text)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('body must be an object')
    }
    return value
  } catch (error) {
    throw Object.assign(new Error(`invalid JSON body: ${error.message}`), { code: 'invalid_json' })
  }
}

/**
 * 同源检查：带 Origin 的请求必须是本页来源；没有 Origin 的（curl / 本地脚本）
 * 放行——防的是网页 CSRF，不是本机命令。
 */
function sameOrigin(req) {
  const origin = req.headers.origin
  if (origin === undefined) return true
  const host = req.headers.host
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** 项目最近一次活动：最近提交 > 台账更新时间 > 创建时间。 */
function lastActiveOf(record) {
  const raw = record.facts?.lastCommit
  if (typeof raw === 'string') {
    const time = Date.parse(raw)
    if (Number.isFinite(time)) return time
  }
  if (typeof record.updatedAt === 'number') return record.updatedAt
  if (typeof record.createdAt === 'number') return record.createdAt
  return null
}

/** 给前端的项目形状（只带界面要用的字段）。 */
export function projectView(record) {
  const keys = Object.keys(record.marks ?? {})
  const version = record.version ?? keys[keys.length - 1]
  const mark = version !== undefined ? (record.marks?.[version] ?? {}) : {}
  const facts = record.facts ?? {}
  return {
    path: record.path,
    name: record.name,
    dir: record.dir,
    version: record.version,
    lastActive: lastActiveOf(record),
    dirty: record.facts?.dirty === true,
    release: latestRelease(record),
    releases: releaseInfo(record),
    repo: record.repo,
    homepage: record.homepage,
    private: record.private === true,
    channel: channelState(record),
    mark,
    versionKey: version,
    facts: {
      tag: facts.tag,
      lastCommit: facts.lastCommit,
      dirty: facts.dirty === true,
      remote: facts.remote,
      npm: record.private === true ? undefined : facts.npm,
      market: facts.market,
      claude: record.claude === true,
      codex: record.codex === true,
    },
  }
}

/**
 * 注册路由。
 * @param {*} webCtx 带 webServer 的上下文
 * @param {{ store: import('./store.js').TaskStore, ready: () => Promise<unknown>, projects?: import('./projects.js').ProjectStore, sessions?: import('./sessions.js').SessionIndex }} deps
 * @returns {() => void} disposer
 */
export function registerRoutes(webCtx, deps) {
  const { store, ready, projects, sessions, schedules } = deps

  const handler = async (req, res) => {
    try {
      if (!sameOrigin(req)) {
        fail(res, 403, 'forbidden', 'untrusted origin')
        return
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const path = url.pathname
      const method = req.method ?? 'GET'

      if (method === 'GET' && path === `${ROUTE_PREFIX}/list`) {
        await ready()
        ok(res, { tasks: store.snapshot() })
        return
      }

      if (method === 'POST' && path === `${ROUTE_PREFIX}/add`) {
        await ready()
        const body = await readJson(req)
        const title = typeof body.title === 'string' ? body.title.trim() : ''
        if (title.length === 0) {
          fail(res, 400, 'invalid_input', '标题不能为空')
          return
        }
        const parsed = typeof body.due === 'string' && body.due.trim().length > 0 ? parseDue(body.due) : null
        const task = await store.add({
          title,
          note: typeof body.note === 'string' ? body.note : undefined,
          priority: body.priority === 1 || body.priority === 2 ? body.priority : undefined,
          dueAt: parsed?.dueAt,
          source: typeof body.sessionId === 'string' || typeof body.cwd === 'string'
            ? { sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined, cwd: typeof body.cwd === 'string' ? body.cwd : undefined }
            : undefined,
        })
        ok(res, { task })
        return
      }

      if (method === 'POST' && path === `${ROUTE_PREFIX}/update`) {
        await ready()
        const body = await readJson(req)
        const id = typeof body.id === 'string' ? body.id : ''
        if (id.length === 0) {
          fail(res, 400, 'invalid_input', '缺少 id')
          return
        }
        const patch = {}
        if (body.done !== undefined) patch.done = body.done === true
        if (body.priority !== undefined) patch.priority = body.priority
        if (typeof body.title === 'string') patch.title = body.title
        if (typeof body.note === 'string') patch.note = body.note
        if (body.dueAt === null) patch.dueAt = null
        else if (typeof body.due === 'string' && body.due.trim().length > 0) {
          const parsed = parseDue(body.due)
          patch.dueAt = parsed?.dueAt ?? null
        }
        if (typeof body.snoozeMinutes === 'number' && Number.isFinite(body.snoozeMinutes) && body.snoozeMinutes > 0) {
          patch.snoozedUntil = Date.now() + Math.min(body.snoozeMinutes, 60 * 24 * 30) * 60_000
        }
        if (body.clearSnooze === true) patch.snoozedUntil = null
        const task = await store.update(id, patch)
        ok(res, { task })
        return
      }

      if (method === 'POST' && path === `${ROUTE_PREFIX}/remove`) {
        await ready()
        const body = await readJson(req)
        const id = typeof body.id === 'string' ? body.id : ''
        if (id.length === 0) {
          fail(res, 400, 'invalid_input', '缺少 id')
          return
        }
        const task = await store.remove(id)
        ok(res, { task })
        return
      }

      // ---------------------------------------------------- 会话 / 项目

      if (method === 'GET' && path === `${ROUTE_PREFIX}/sessions`) {
        if (sessions === undefined || projects === undefined) {
          ok(res, { sessions: [] })
          return
        }
        await projects.ready()
        const rows = await sessions.unfinished({ ended: projects.data.sessions, ignored: projects.data.sessions })
        ok(res, { sessions: rows })
        return
      }

      if (method === 'GET' && path === `${ROUTE_PREFIX}/schedules`) {
        if (schedules === undefined) {
          ok(res, { schedules: [] })
          return
        }
        const rows = await schedules.list(sessions)
        ok(res, { schedules: rows })
        return
      }

      if (method === 'GET' && path === `${ROUTE_PREFIX}/projects`) {
        if (projects === undefined) {
          ok(res, { projects: [] })
          return
        }
        const rows = await projects.list()
        ok(res, {
          projects: rows.map(projectView),
          refreshing: projects.netRunning,
        })
        return
      }

      if (method === 'GET' && path === `${ROUTE_PREFIX}/session`) {
        if (projects === undefined || sessions === undefined) {
          ok(res, { session: null, project: null })
          return
        }
        const sessionId = url.searchParams.get('session') ?? ''
        if (sessionId.length === 0) {
          fail(res, 400, 'invalid_input', '缺少 session')
          return
        }
        await projects.ready()
        const info = await sessions.get(sessionId)
        const resolved = projects.resolveSession(sessionId, { cwd: info?.cwd, title: info?.title, hints: info?.hints })
        const scores = projects.scoreProjects(info?.title ?? '', info?.hints ?? [])
        const ranked = (await projects.list())
          .map((record) => ({ record, match: scores.get(record.path) ?? 0 }))
          .sort((a, b) => b.match - a.match)
        const candidates = ranked.slice(0, 12).map(({ record, match }) => ({
          path: record.path,
          name: record.name,
          version: record.version,
          lastActive: lastActiveOf(record),
          dirty: record.facts?.dirty === true,
          release: latestRelease(record),
          channel: channelState(record),
          match,
        }))
        // 猜你在做：分数最高且唯一，就摆到最上面让你一键确认
        const guess = ranked[0] !== undefined && ranked[0].match >= 2
          && (ranked[1] === undefined || ranked[1].match < ranked[0].match)
          ? projectView(ranked[0].record)
          : null
        ok(res, {
          session: {
            id: sessionId,
            title: info?.title ?? null,
            cwd: info?.cwd ?? null,
            endedAt: projects.data.sessions[sessionId]?.endedAt ?? null,
          },
          project: resolved.record === null ? null : projectView(resolved.record),
          via: resolved.via,
          guess,
          candidates,
        })
        return
      }

      if (method === 'POST' && path === `${ROUTE_PREFIX}/bind`) {
        if (projects === undefined) {
          fail(res, 500, 'unavailable', '项目服务未就绪')
          return
        }
        const body = await readJson(req)
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        const projectPath = typeof body.path === 'string' ? body.path : ''
        if (sessionId.length === 0 || projectPath.length === 0) {
          fail(res, 400, 'invalid_input', '缺少 sessionId 或 path')
          return
        }
        await projects.ready()
        await projects.bind(sessionId, projectPath)
        const record = projects.get(projectPath)
        ok(res, { project: record === undefined ? null : projectView(record) })
        return
      }

      if (method === 'POST' && path === `${ROUTE_PREFIX}/mark`) {
        if (projects === undefined) {
          fail(res, 500, 'unavailable', '项目服务未就绪')
          return
        }
        const body = await readJson(req)
        const projectPath = typeof body.path === 'string' ? body.path : ''
        if (projectPath.length === 0) {
          fail(res, 400, 'invalid_input', '缺少 path')
          return
        }
        await projects.ready()
        const record = await projects.mark(projectPath, typeof body.version === 'string' ? body.version : undefined, {
          devDone: body.devDone,
          channel: typeof body.channel === 'string' && body.channel.length > 0 ? body.channel : undefined,
          value: body.value,
        })
        ok(res, { project: projectView(record) })
        return
      }

      if (method === 'POST' && path === `${ROUTE_PREFIX}/session/ignore`) {
        if (projects === undefined) {
          fail(res, 500, 'unavailable', '项目服务未就绪')
          return
        }
        const body = await readJson(req)
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        if (sessionId.length === 0) {
          fail(res, 400, 'invalid_input', '缺少 sessionId')
          return
        }
        await projects.ready()
        const session = body.undo === true
          ? await projects.unignoreSession(sessionId)
          : await projects.ignoreSession(sessionId, body.promptAt)
        ok(res, { session })
        return
      }

      if (method === 'POST' && path === `${ROUTE_PREFIX}/end-session`) {
        if (projects === undefined) {
          fail(res, 500, 'unavailable', '项目服务未就绪')
          return
        }
        const body = await readJson(req)
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        if (sessionId.length === 0) {
          fail(res, 400, 'invalid_input', '缺少 sessionId')
          return
        }
        await projects.ready()
        const session = body.reopen === true
          ? await projects.reopenSession(sessionId)
          : await projects.endSession(sessionId)
        ok(res, { session })
        return
      }

      fail(res, 404, 'not_found', `unknown route ${method} ${path}`)
    } catch (error) {
      if (error?.code === 'too_large') {
        fail(res, 413, 'too_large', '请求体太大')
        return
      }
      if (error?.code === 'invalid_json') {
        fail(res, 400, 'invalid_json', error.message)
        return
      }
      console.warn('[dsh-followup] route failed:', error)
      fail(res, 400, 'failed', error instanceof Error ? error.message : String(error))
    }
  }

  return webCtx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler })
}
