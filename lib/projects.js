/**
 * 项目台账：发现工作区里的项目，收集发布事实，存用户的一键标记。
 *
 * - 发现：每个 DSH 工作区根 + 其下带 package.json/.git 的直接子目录
 * - 事实：package.json / git（版本、仓库、tag、最近提交、脏工作区）、
 *   npm latest、DSH 市场收录页；都带缓存，网络失败不影响本地视图
 * - 标记：按版本记（v1.1.0 开发完成 / 发了哪些渠道），存在 followup/projects.json
 * - 绑定：sessionId → 项目路径，以及「这个对话收尾了」的 endedAt
 *
 * @module dsh-followup/lib/projects
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import { dshHome } from './store.js'

const LOCAL_TTL = 60_000
const NET_TTL = 3_600_000
const GIT_TIMEOUT = 2_500
const NET_TIMEOUT = 5_000

/** 跑一个命令，失败/超时返回空串。 */
function run(file, args, timeout = GIT_TIMEOUT) {
  return new Promise((done) => {
    execFile(file, args, { timeout, maxBuffer: 1e6 }, (error, stdout) => {
      done(error ? '' : String(stdout).trim())
    })
  })
}

/** DSH 的工作区根（读 storages/workspace.json）。 */
export async function workspaceRoots() {
  try {
    const raw = JSON.parse(await readFile(join(dshHome(), 'storages', 'workspace.json'), 'utf8'))
    const paths = Object.values(raw?.tables?.workspaces ?? {})
      .map((workspace) => workspace?.path)
      .filter((path) => typeof path === 'string' && path.length > 0)
    return [...new Set(paths.map((path) => resolve(path)))]
  } catch {
    return []
  }
}

/** 一个目录像不像项目：有 package.json 或 .git。 */
async function hasMarker(dir) {
  try {
    await readFile(join(dir, 'package.json'), 'utf8')
    return true
  } catch {
    /* 继续看 git */
  }
  return existsSync(join(dir, '.git'))
}

const MAX_SCAN_DEPTH = 2
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.cache', '.turbo', 'tmp', '.tmp',
])
const GENERIC_NAMES = new Set(['plugin', 'plugins', 'app', 'src', 'web', 'ui', 'tools', 'dsh', 'deepseek-harness'])
// dsh-plugin 几乎每个插件的 keywords 里都有，拿来算提及次数会让所有插件一起得分
const GENERIC_KEYWORDS = new Set(['dsh', 'dsh-plugin', 'plugin', 'plugins', 'web', 'deepseek', 'deepseek-harness', 'ui', 'tool', 'tools', 'task', 'tasks', 'sidebar'])

/**
 * 去重键：同一个包被两个目录各扫到一次时（旧工作区副本 + 新目录），name 和
 * 仓库相同，就当成同一个项目展示和评分。仓库地址归一成 github owner/repo。
 */
export function repoKey(record) {
  const name = typeof record?.name === 'string' ? record.name.toLowerCase() : ''
  let repo = typeof record?.repo === 'string' ? record.repo : ''
  if (repo.length === 0 && record?.github?.owner !== undefined && record?.github?.repo !== undefined) {
    repo = `github.com/${record.github.owner}/${record.github.repo}`
  }
  const github = parseGitHub(repo)
  if (github !== null) repo = `github.com/${github.owner}/${github.repo}`
  if (repo.length === 0) repo = typeof record?.path === 'string' ? record.path : ''
  return `${name}|${repo.toLowerCase()}`
}

function ignoredDir(name) {
  return name.startsWith('.') || SKIP_DIRS.has(name) || /backup/i.test(name)
}

/** 递归发现有 marker 的目录；遇到项目就停止，不再往项目内部扫。 */
async function scanProjectDir(dir, depth, found) {
  if (await hasMarker(dir)) {
    found.add(dir)
    return
  }
  if (depth >= MAX_SCAN_DEPTH) return
  let entries = []
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || ignoredDir(entry.name)) continue
    await scanProjectDir(join(dir, entry.name), depth + 1, found)
  }
}

/** 发现项目路径：工作区根 + 最多两层子目录。 */
export async function discoverProjectPaths() {
  const roots = await workspaceRoots()
  const found = new Set()
  for (const root of roots) await scanProjectDir(root, 0, found)
  return [...found].sort()
}

/** 读 package.json 里我们关心的字段。 */
async function readPackage(dir) {
  try {
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    const repository = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
    return {
      name: typeof pkg.name === 'string' ? pkg.name : undefined,
      version: typeof pkg.version === 'string' ? pkg.version : undefined,
      repository: typeof repository === 'string' ? repository : undefined,
      homepage: typeof pkg.homepage === 'string' ? pkg.homepage : undefined,
      private: pkg.private === true,
      description: typeof pkg.description === 'string' ? pkg.description : undefined,
      keywords: Array.isArray(pkg.keywords)
        ? pkg.keywords.filter((item) => typeof item === 'string' && item.length > 0)
        : [],
    }
  } catch {
    return {}
  }
}

/** 从仓库地址里解析 GitHub owner/repo。 */
export function parseGitHub(url) {
  if (typeof url !== 'string') return null
  const match = url.match(/github\.com[:/]([^/]+)\/([^/.#]+?)(?:\.git)?(?:[#/]|$)/i)
  if (match === null) return null
  return { owner: match[1], repo: match[2].replace(/\.git$/i, '') }
}

/** 本地 git 事实。 */
async function gitFacts(dir) {
  if (!existsSync(join(dir, '.git'))) return {}
  const [remote, tag, lastCommit, porcelain] = await Promise.all([
    run('git', ['-C', dir, 'remote', 'get-url', 'origin']),
    run('git', ['-C', dir, 'describe', '--tags', '--abbrev=0']),
    run('git', ['-C', dir, 'log', '-1', '--format=%cI']),
    run('git', ['-C', dir, 'status', '--porcelain']),
  ])
  return {
    remote: remote.length > 0 ? remote : undefined,
    tag: tag.length > 0 ? tag : undefined,
    lastCommit: lastCommit.length > 0 ? lastCommit : undefined,
    dirty: porcelain.length > 0,
  }
}

/** npm registry 上这一版是多少；'none' = 没发过，null = 查不到。 */
async function npmLatest(name) {
  if (typeof name !== 'string' || name.length === 0 || name.startsWith('@local/')) return null
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), NET_TIMEOUT)
    const response = await fetch(`https://registry.npmjs.org/${name}/latest`, { signal: controller.signal })
    clearTimeout(timer)
    if (response.status === 404) return 'none'
    if (!response.ok) return null
    const body = await response.json()
    return typeof body?.version === 'string' ? body.version : null
  } catch {
    return null
  }
}

/** DSH 市场收录页是否 200。 */
async function marketListed(owner, repo) {
  if (owner === undefined || repo === undefined) return null
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), NET_TIMEOUT)
    const response = await fetch(`https://awesome-dsh-plugin.com/p/${owner}/${repo}/`, {
      signal: controller.signal,
      redirect: 'follow',
    })
    clearTimeout(timer)
    return response.status === 200
  } catch {
    return null
  }
}

/** 新项目记录的骨架。 */
function blankRecord(path) {
  return { path, name: basename(path), version: undefined, marks: {}, facts: {}, createdAt: Date.now(), updatedAt: Date.now() }
}

/** 项目台账：标记、绑定、收尾，以及事实缓存。 */
export class ProjectStore {
  constructor(options = {}) {
    this.file = options.file ?? join(dshHome(), 'followup', 'projects.json')
    this.data = { version: 1, projects: {}, sessions: {}, updatedAt: 0 }
    this.loaded = false
    this.queue = Promise.resolve()
    this.scannedAt = 0
    this.netRunning = false
  }

  async ready() {
    if (this.loaded) return this
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8'))
      if (raw !== null && typeof raw === 'object') {
        this.data = {
          version: 1,
          projects: raw.projects ?? {},
          sessions: raw.sessions ?? {},
          updatedAt: raw.updatedAt ?? 0,
        }
      }
    } catch {
      /* 没有文件 = 空台账 */
    }
    this.loaded = true
    return this
  }

  async save() {
    // 串行化 + 唯一临时文件：扫描和网络刷新可能同时落盘
    this.saveQueue = (this.saveQueue ?? Promise.resolve()).then(async () => {
      await mkdir(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
      this.data.updatedAt = Date.now()
      await writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8')
      await rename(tmp, this.file)
    })
    return this.saveQueue
  }

  /** 串行一次修改。 */
  mutate(fn) {
    this.queue = this.queue.then(async () => {
      await this.ready()
      const result = await fn()
      await this.save()
      return result
    })
    return this.queue
  }

  /** 扫描 + 刷新本地事实；30 秒内复用。 */
  async scan(force = false) {
    await this.ready()
    if (!force && Date.now() - this.scannedAt < LOCAL_TTL) return this
    const paths = await discoverProjectPaths()
    this.scannedAt = Date.now()
    this.visiblePaths = new Set(paths)
    await this.ready()
    for (const path of paths) {
      if (this.data.projects[path] === undefined) this.data.projects[path] = blankRecord(path)
    }
    // 本地事实并行刷新，最后只写一次盘
    await Promise.all(paths.map((path) => this.refreshLocal(path)))
    await this.mutate(() => {})
    return this
  }

  /** 刷新一个项目的本地事实。 */
  async refreshLocal(path) {
    const record = this.data.projects[path]
    if (record === undefined) return
    if (record.facts?.at !== undefined && Date.now() - record.facts.at < LOCAL_TTL) return
    const [pkg, git] = await Promise.all([readPackage(path), gitFacts(path)])
    const name = pkg.name?.replace(/^@[^/]+\//, '') ?? basename(path)
    const repo = pkg.repository ?? git.remote
    const github = parseGitHub(repo)
    record.name = name
    record.dir = basename(path)
    record.version = pkg.version
    record.repo = repo
    record.homepage = pkg.homepage
    record.private = pkg.private === true
    record.description = pkg.description
    record.keywords = pkg.keywords ?? []
    record.facts = {
      ...record.facts,
      ...git,
      at: Date.now(),
    }
    record.github = github ?? record.github ?? null
    record.claude = existsSync(join(path, '.claude-plugin'))
    record.codex = existsSync(join(path, '.codex-plugin'))
    record.updatedAt = Date.now()
  }

  /** 刷新网络事实（npm / 市场），1 小时缓存；不阻塞调用方。 */
  async refreshNetwork() {
    if (this.netRunning) return
    this.netRunning = true
    try {
      await this.ready()
      const now = Date.now()
      const records = Object.values(this.data.projects)
      await Promise.all(records.map(async (record) => {
        if (record.facts?.netAt !== undefined && now - record.facts.netAt < NET_TTL) return
        const name = record.name
        const github = record.github ?? null
        const [npm, market] = await Promise.all([
          npmLatest(record.private === true ? undefined : name),
          marketListed(github?.owner, github?.repo),
        ])
        record.facts = { ...record.facts, npm, market, netAt: Date.now() }
        record.updatedAt = Date.now()
      }))
      await this.save()
    } finally {
      this.netRunning = false
    }
  }

  /** 去重后的可见项目：同名同仓库只留一条（stamp 最新的；同分按 path 稳定排序）。 */
  visibleRecords() {
    const visible = this.visiblePaths ?? new Set(Object.keys(this.data.projects))
    const groups = new Map()
    for (const record of Object.values(this.data.projects)) {
      if (!visible.has(record.path)) continue
      const key = repoKey(record)
      const group = groups.get(key)
      if (group === undefined) groups.set(key, [record])
      else group.push(record)
    }
    const rows = []
    for (const group of groups.values()) {
      if (group.length === 1) {
        rows.push(group[0])
        continue
      }
      group.sort((a, b) => stamp(b) - stamp(a) || String(a.path).localeCompare(String(b.path)))
      rows.push(group[0])
    }
    return rows
  }

  /** 返回可见项目（最近活动在前）。 */
  async list() {
    await this.scan()
    const now = Date.now()
    const rows = this.visibleRecords().map((record) => ({
      ...record,
      channel: channelState(record),
      netPending: record.facts?.netAt === undefined || now - record.facts.netAt >= NET_TTL,
    }))
    rows.sort((a, b) => stamp(b) - stamp(a) || a.name.localeCompare(b.name))
    // 后台补网络事实
    if (rows.some((row) => row.netPending)) void this.refreshNetwork()
    return rows
  }

  /** 按路径拿一条。 */
  get(path) {
    return this.data.projects[path]
  }

  /** 记一个标记；channel 为空表示只改「开发完成」。 */
  mark(path, version, patch) {
    return this.mutate(() => {
      const record = this.data.projects[path]
      if (record === undefined) throw new Error(`没有这个项目：${path}`)
      const key = typeof version === 'string' && version.length > 0 ? version : (record.version ?? '未标版本')
      record.marks = record.marks ?? {}
      const current = record.marks[key] ?? { devDone: false, channels: {}, at: Date.now() }
      if (patch.devDone !== undefined) current.devDone = patch.devDone === true
      if (patch.channel !== undefined) {
        current.channels = current.channels ?? {}
        const value = patch.value === true || patch.value === 'pending' ? patch.value : false
        current.channels[patch.channel] = value
        current.channelAt = current.channelAt ?? {}
        if (value === false) delete current.channelAt[patch.channel]
        else current.channelAt[patch.channel] = Date.now()
      }
      current.at = Date.now()
      record.marks[key] = current
      record.updatedAt = Date.now()
      return record
    })
  }

  /** 绑定一个对话到项目。 */
  bind(sessionId, path) {
    return this.mutate(() => {
      const session = this.data.sessions[sessionId] ?? {}
      session.projectPath = path
      session.boundAt = Date.now()
      this.data.sessions[sessionId] = session
      return session
    })
  }

  /** 用户点了「这个对话收尾了」。 */
  endSession(sessionId) {
    return this.mutate(() => {
      const session = this.data.sessions[sessionId] ?? {}
      session.endedAt = Date.now()
      this.data.sessions[sessionId] = session
      return session
    })
  }

  /** 手动忽略一个对话：直到它有了新活动才回来。 */
  ignoreSession(sessionId, promptAt) {
    return this.mutate(() => {
      const session = this.data.sessions[sessionId] ?? {}
      session.ignoredPromptAt = typeof promptAt === 'number' && Number.isFinite(promptAt) ? promptAt : Date.now()
      this.data.sessions[sessionId] = session
      return session
    })
  }

  /** 取消忽略。 */
  unignoreSession(sessionId) {
    return this.mutate(() => {
      const session = this.data.sessions[sessionId] ?? {}
      delete session.ignoredPromptAt
      this.data.sessions[sessionId] = session
      return session
    })
  }

  /** 重新打开一个已收尾的对话。 */
  reopenSession(sessionId) {
    return this.mutate(() => {
      const session = this.data.sessions[sessionId] ?? {}
      delete session.endedAt
      this.data.sessions[sessionId] = session
      return session
    })
  }

  /**
   * 项目与对话的匹配：标题命中 3 分；对话摘要里每提到一次 2 分起、最多 6 分。
   * 去重后再评分，所以旧工作区的同名副本不会把分数劈成两半。
   * @param {string} title 会话标题
   * @param {string[]} hints 对话内容摘要
   * @returns {Map<string,{score:number,titleHit:boolean,mentions:number}>} path → 依据
   */
  scoreProjects(title, hints) {
    const titleText = typeof title === 'string' ? title.toLowerCase() : ''
    const text = Array.isArray(hints)
      ? hints.map((hint) => String(hint)).join('\n').toLowerCase()
      : ''
    const scores = new Map()
    for (const record of this.visibleRecords()) {
      const names = [record.name, record.dir]
        .filter((name) => typeof name === 'string' && name.length >= 3 && !GENERIC_NAMES.has(name.toLowerCase()))
        .map((name) => name.toLowerCase())
      const keywords = (Array.isArray(record.keywords) ? record.keywords : [])
        .map((item) => String(item).toLowerCase())
        .filter((item) => item.length >= 3 && !GENERIC_KEYWORDS.has(item))
      const matchNames = [...new Set([...names, ...keywords])]
      if (matchNames.length === 0) continue
      const titleHit = titleText.length > 0 && matchNames.some((name) => titleText.includes(name))
      let mentions = 0
      if (text.length > 0) {
        // 长名优先，避免 dsh-followup 同时被当成 followup 再数一遍
        const pattern = matchNames
          .slice()
          .sort((a, b) => b.length - a.length)
          .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('|')
        const matches = text.match(new RegExp(pattern, 'g'))
        mentions = matches === null ? 0 : matches.length
      }
      let score = 0
      if (titleHit) score += 3
      if (mentions > 0) score += 2 + Math.min(mentions - 1, 4)
      if (score > 0) scores.set(record.path, { score, titleHit, mentions })
    }
    return scores
  }

  /**
   * 解析一个对话对应的项目：显式绑定 → cwd → 对话内容/标题。
   * 只有唯一最高分才锁定；并列就交给用户（不瞎猜）。
   * @returns {{record:object|null, via:'bound'|'cwd'|'title'|'context'|null, match:{score:number,titleHit:boolean,mentions:number}|null}}
   */
  resolveSession(sessionId, info = {}) {
    const explicit = this.data.sessions[sessionId]?.projectPath
    if (typeof explicit === 'string') {
      const record = this.data.projects[explicit]
      if (record !== undefined) return { record, via: 'bound', match: null }
    }
    const cwd = typeof info.cwd === 'string' ? info.cwd : ''
    if (cwd.length > 0) {
      const best = Object.values(this.data.projects)
        .filter((record) => cwd === record.path || cwd.startsWith(`${record.path}/`))
        .sort((a, b) => b.path.length - a.path.length)[0]
      if (best !== undefined) return { record: best, via: 'cwd', match: null }
      // 对话 cwd 是工作区根、下面只有一个可见项目（例如 usage-card/plugin）：
      // 直接锁定，不再让关键词去猜。
      const inside = this.visibleRecords()
        .filter((record) => record.path.startsWith(`${cwd}/`))
        .sort((a, b) => a.path.length - b.path.length)
      if (inside.length === 1) return { record: inside[0], via: 'cwd', match: null }
    }
    const title = typeof info.title === 'string' ? info.title : ''
    const hints = Array.isArray(info.hints) ? info.hints : []
    const ranked = [...this.scoreProjects(title, hints).entries()]
      .sort((a, b) => b[1].score - a[1].score)
    // 证据太弱或两个项目一样像：不瞎猜，交给用户点一次
    if (ranked.length === 0 || ranked[0][1].score < 2) return { record: null, via: null, match: null }
    if (ranked.length > 1 && ranked[0][1].score === ranked[1][1].score) return { record: null, via: null, match: null }
    const [path, match] = ranked[0]
    return {
      record: this.data.projects[path] ?? null,
      via: match.titleHit ? 'title' : 'context',
      match,
    }
  }
}

const CHANNEL_LABELS = { github: 'GitHub', npm: 'npm', market: '市场', site: '自己的站' }

const CHANNEL_LIST = ['github', 'npm', 'market', 'site']
const NPM_NONE = new Set(['none', 'error'])

/**
 * 每个渠道的状态与已发版本，以及本地相对于已发的状态。
 * 状态：off / pending（仅市场）/ on；待迭代/待发布/已发布由版本对比推导。
 * @param {object} record
 * @returns {{ local: string|null, channels: Record<string,{state:'off'|'pending'|'on',version:string|null}>, status: {key:string,label:string}|null }}
 */
export function releaseInfo(record) {
  const facts = record.facts ?? {}
  const local = typeof record.version === 'string' ? record.version : null
  const mark = local !== null ? record.marks?.[local] : undefined
  const channels = {}
  for (const channel of CHANNEL_LIST) {
    const manual = mark?.channels?.[channel]
    let state = 'off'
    let version = null
    if (manual === 'pending') state = 'pending'
    else if (manual === true) {
      state = 'on'
      version = local
    } else if (channel === 'github' && typeof facts.tag === 'string' && facts.tag.length > 0 && typeof facts.remote === 'string') {
      state = 'on'
      version = facts.tag.replace(/^v/i, '')
    } else if (channel === 'npm' && typeof facts.npm === 'string' && !NPM_NONE.has(facts.npm)) {
      state = 'on'
      version = facts.npm
    } else if (channel === 'market' && facts.market === true) {
      state = 'on'
    }
    channels[channel] = { state, version }
  }
  const released = CHANNEL_LIST.map((channel) => channels[channel]).filter((item) => item.state === 'on')
  const ahead = released.length > 0 && !released.some((item) => item.version !== null && item.version === local)
  const dirty = facts.dirty === true
  let status = null
  if (dirty) status = { key: 'dirty', label: '有改动' }
  else if (released.length === 0 && mark?.channels?.market === 'pending') status = { key: 'pending', label: '待审核' }
  else if (released.length === 0 && mark?.devDone === true) status = { key: 'ready', label: '待发布' }
  else if (ahead) status = { key: 'ahead', label: '待迭代' }
  else if (released.length > 0) status = { key: 'released', label: '已发布' }
  return { local, channels, status }
}

/**
 * 最近一次发布渠道：手动标记优先（按 channelAt / mark.at 取最新），
 * 没有标记时退回自动事实（tag → npm → 市场收录）。
 * @param {object} record 项目记录
 * @returns {{channel:string,label:string,at:number|null,source:'manual'|'auto'} | null}
 */
export function latestRelease(record) {
  const version = record.version
  const mark = version !== undefined ? record.marks?.[version] : undefined
  let best = null
  if (mark?.channels !== undefined && mark.channels !== null) {
    for (const [channel, on] of Object.entries(mark.channels)) {
      if (on !== true) continue
      const at = typeof mark.channelAt?.[channel] === 'number' ? mark.channelAt[channel] : (typeof mark.at === 'number' ? mark.at : null)
      if (best === null || (at ?? 0) > (best.at ?? 0)) {
        best = { channel, label: CHANNEL_LABELS[channel] ?? channel, at }
      }
    }
  }
  if (best !== null) return { ...best, source: 'manual' }
  const facts = record.facts ?? {}
  if (typeof facts.tag === 'string' && facts.tag.length > 0 && typeof facts.remote === 'string') {
    return { channel: 'github', label: 'GitHub', at: null, source: 'auto' }
  }
  if (typeof facts.npm === 'string' && facts.npm !== 'none' && facts.npm !== 'error' && facts.npm.length > 0) {
    return { channel: 'npm', label: 'npm', at: null, source: 'auto' }
  }
  if (facts.market === true) return { channel: 'market', label: '市场', at: null, source: 'auto' }
  return null
}

/** 项目最近活动的时间戳。 */
function stamp(record) {
  const facts = record.facts ?? {}
  if (typeof facts.lastCommit === 'string') {
    const time = Date.parse(facts.lastCommit)
    if (Number.isFinite(time)) return time
  }
  return record.updatedAt ?? record.createdAt ?? 0
}

/**
 * 合并事实与标记，得到每个渠道的显示状态。
 * @returns {{github:boolean, npm:boolean, market:boolean, site:boolean, devDone:boolean}}
 */
export function channelState(record) {
  const keys = Object.keys(record.marks ?? {})
  const version = record.version ?? keys[keys.length - 1]
  const mark = version !== undefined ? (record.marks?.[version] ?? {}) : {}
  const facts = record.facts ?? {}
  const tag = facts.tag ?? ''
  const npm = facts.npm
  const githubAuto = facts.remote !== undefined && tag.length > 0
  const npmAuto = record.private !== true && typeof npm === 'string' && npm !== 'none' && npm !== 'error' && npm.length > 0
  const marketAuto = facts.market === true
  return {
    devDone: mark.devDone === true,
    github: mark.channels?.github === true || (mark.channels?.github === undefined && githubAuto),
    npm: mark.channels?.npm === true || (mark.channels?.npm === undefined && npmAuto),
    market: mark.channels?.market === true || (mark.channels?.market === undefined && marketAuto),
    site: mark.channels?.site ?? false,
  }
}
