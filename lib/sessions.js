/**
 * 会话投影索引：判断「这个对话还有没有没收尾的东西」。
 *
 * 数据来自 DSH 自己的会话投影缓存（session_projcache）——标题、最后活动、
 * todo 清单、goal、等你回答的问题、计划模式、团队任务、turn 边界都在里面。
 * 这里只做只读分析，不改任何会话。
 *
 * @module dsh-followup/lib/sessions
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { dshHome } from './store.js'

const REFRESH_MS = 20_000
const IDLE_MS = 10 * 60_000

/** 取投影里某一行当前值。 */
function row(record, key) {
  return record?.rows?.[key]?.val
}

/** 分析一份会话投影。 */
function analyze(record) {
  const meta = row(record, 'sessionListMetadata') ?? {}
  const turn = row(record, 'turnBoundary') ?? {}
  const todos = row(record, 'todos')
  const goal = row(record, 'goal')
  const questions = row(record, 'userQuestions')
  const plan = row(record, 'plan')
  const team = row(record, 'agentTeam')
  const title = row(record, 'title')
  const cwd = record?.identity?.cwd

  const openTurn = turn.openTurnStartSeq !== null && turn.openTurnStartSeq !== undefined
  const activeQuestions = Array.isArray(questions?.questions?.active) ? questions.questions.active.length : 0
  const unfinishedTodos = Array.isArray(todos)
    ? todos.filter((item) => item?.status !== 'completed').length
    : 0
  const goalActive = goal?.current?.goal?.phase === 'active'
  const planActive = plan?.active === true
  const teamOpenTasks = Array.isArray(team?.tasks)
    ? team.tasks.filter((task) => task?.status !== 'completed' && task?.status !== 'canceled')
    : []
  const teamOpen = teamOpenTasks.length
  const teamTasks = teamOpenTasks.slice(0, 3).map((task) => (typeof task?.subject === 'string' ? task.subject : '未命名任务'))
  const blank = meta.blank === true
  // 普通会话的 subagent 投影是空对象 {}，只有真正的子代理才有 identity/parentId
  const subagentValue = row(record, 'subagent')
  const subagent = subagentValue !== null
    && typeof subagentValue === 'object'
    && (subagentValue.identity !== undefined || subagentValue.parentId !== undefined)
  const lastPromptAt = typeof meta.lastPromptAt === 'number' ? meta.lastPromptAt : null

  // 对话内容摘要（投影里只有前 120 字），用来猜它属于哪个项目，不做语义推断
  const hints = []
  const first = row(record, 'titleInput')?.first?.text
  if (typeof first === 'string' && first.length > 0) hints.push(first.slice(0, 240))
  const outline = row(record, 'turnOutline')
  if (Array.isArray(outline?.turns)) {
    for (const turn of outline.turns.slice(-10)) {
      if (typeof turn?.prompt === 'string' && turn.prompt.length > 0) hints.push(turn.prompt)
      if (typeof turn?.response === 'string' && turn.response.length > 0) hints.push(turn.response)
    }
  }

  // 只返回原因码和参数，界面文案由客户端按语言翻译
  const reasons = []
  if (activeQuestions > 0) reasons.push({ code: 'waiting' })
  if (unfinishedTodos > 0) reasons.push({ code: 'todos', count: unfinishedTodos })
  if (goalActive) reasons.push({ code: 'goal' })
  if (planActive) reasons.push({ code: 'plan' })
  if (teamOpen > 0) reasons.push({ code: 'team', count: teamOpen })
  if (openTurn) reasons.push({ code: 'running' })

  const idleDays = lastPromptAt === null ? 0 : (Date.now() - lastPromptAt) / 86_400_000
  const category = activeQuestions > 0
    ? 'wait'
    : openTurn
      ? 'running'
      : reasons.length > 0
        ? (idleDays > 7 ? 'dormant' : 'idle')
        : null
  return {
    id: undefined,
    title: typeof title === 'string' && title.length > 0 ? title : '未命名对话',
    cwd: typeof cwd === 'string' ? cwd : undefined,
    reasons,
    teamTasks,
    category,
    openTurn,
    blank,
    subagent,
    lastPromptAt,
    activityAt: lastPromptAt,
    hints,
  }
}

/** 会话索引（只读、带 mtime 缓存）。 */
export class SessionIndex {
  constructor(options = {}) {
    this.dir = options.dir ?? join(dshHome(), 'storages', 'session_projcache', 'sessions')
    this.workspaceFile = options.workspaceFile ?? join(dshHome(), 'storages', 'workspace.json')
    this.cache = new Map()
    this.sessions = new Map()
    this.archived = new Set()
    this.scannedAt = 0
  }

  /** 重新扫一遍；20 秒内复用。 */
  async refresh(force = false) {
    if (!force && Date.now() - this.scannedAt < REFRESH_MS) return
    this.scannedAt = Date.now()
    let files = []
    try {
      files = (await readdir(this.dir)).filter((name) => name.endsWith('.json'))
    } catch {
      this.sessions = new Map()
      return
    }
    const sessions = new Map()
    for (const file of files) {
      const full = join(this.dir, file)
      let mtime = 0
      try {
        mtime = (await stat(full)).mtimeMs
      } catch {
        continue
      }
      let entry = this.cache.get(full)
      if (entry === undefined || entry.mtime !== mtime) {
        try {
          const parsed = JSON.parse(await readFile(full, 'utf8'))
          const record = parsed?.record ?? {}
          const info = analyze(record)
          info.id = file.replace(/\.json$/, '')
          entry = { mtime, info }
          this.cache.set(full, entry)
        } catch {
          continue
        }
      }
      sessions.set(entry.info.id, entry.info)
    }
    this.sessions = sessions
    await this.loadArchived()
  }

  /** 读工作区里被归档的会话 id。 */
  async loadArchived() {
    try {
      const raw = JSON.parse(await readFile(this.workspaceFile, 'utf8'))
      const ids = raw?.global?.archivedSessionIds
      this.archived = new Set(Array.isArray(ids) ? ids : [])
    } catch {
      this.archived = new Set()
    }
  }

  /** 单个会话（标题 / cwd）。 */
  async get(id) {
    await this.refresh()
    return this.sessions.get(id)
  }

  /**
   * 当前「未收尾」的会话。
   * @param {{ ended?: Record<string, {endedAt?: number}>, now?: number }} options
   */
  async unfinished(options = {}) {
    await this.refresh()
    const now = options.now ?? Date.now()
    const ended = options.ended ?? {}
    const ignored = options.ignored ?? {}
    const rows = []
    for (const info of this.sessions.values()) {
      if (info.blank || info.subagent) continue
      if (this.archived.has(info.id)) continue
      if (ended[info.id]?.endedAt !== undefined) continue
      // 手动忽略：只有这个对话之后又有了新活动才会重新出现
      const ignoredAt = ignored[info.id]?.ignoredPromptAt
      if (typeof ignoredAt === 'number' && (info.lastPromptAt ?? 0) <= ignoredAt) continue
      if (info.category === null) continue
      // 正在跑的会话不叫“未收尾”：最近 10 分钟还在动就跳过；卡住的（长时间 open turn）才露出
      if (info.category === 'running' && info.lastPromptAt !== null && now - info.lastPromptAt < IDLE_MS) continue
      if (info.category === 'idle' && info.lastPromptAt !== null && now - info.lastPromptAt < IDLE_MS) continue
      const { hints, ...rest } = info
      rows.push({ ...rest, projectName: info.cwd ? info.cwd.split('/').filter(Boolean).pop() : undefined })
    }
    const rank = { wait: 0, running: 1, idle: 2, dormant: 3 }
    rows.sort((a, b) => (rank[a.category] - rank[b.category]) || ((b.lastPromptAt ?? 0) - (a.lastPromptAt ?? 0)))
    return rows
  }
}
