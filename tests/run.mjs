/**
 * dsh-followup 的最小自检：不装进 DSH 也能跑。
 *
 *   node tests/run.mjs
 *
 * 覆盖：日期解析、存储增删改、宿主半 apply 的注册形状、HTTP 路由行为。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { parseDue, formatDue } from '../lib/dates.js'
import { TaskStore } from '../lib/store.js'
import { ProjectStore, channelState, releaseInfo } from '../lib/projects.js'
import { SessionIndex } from '../lib/sessions.js'
import { ScheduleIndex } from '../lib/schedules.js'
import { apply } from '../index.js'

let passed = 0
let failed = 0
const failures = []

function check(name, ok, detail = '') {
  if (ok) {
    passed++
    console.log(`PASS  ${name}`)
  } else {
    failed++
    failures.push(`${name} ${detail}`)
    console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`)
  }
}

// ------------------------------------------------------------------ dates
{
  const now = new Date(2026, 10, 2, 10, 0, 0).getTime() // 2026-11-02 10:00 本地
  const cases = [
    ['明天下午3点', new Date(2026, 10, 3, 15, 0).getTime()],
    ['明天', new Date(2026, 10, 3, 9, 0).getTime()],
    ['后天上午10点半', new Date(2026, 10, 4, 10, 30).getTime()],
    ['3天后', new Date(2026, 10, 5, 9, 0).getTime()],
    ['周五', new Date(2026, 10, 6, 9, 0).getTime()],
    ['2026-11-03 16:45', new Date(2026, 10, 3, 16, 45).getTime()],
    ['今晚8点', new Date(2026, 10, 2, 20, 0).getTime()],
  ]
  for (const [text, expected] of cases) {
    const parsed = parseDue(text, now)
    check(`date: ${text}`, parsed !== null && parsed.dueAt === expected,
      parsed === null ? '返回 null' : `${new Date(parsed.dueAt).toString()} != ${new Date(expected).toString()}`)
  }
  check('date: 无法解析返回 null', parseDue('随便写写', now) === null)
  check('date: 格式化明天', formatDue(new Date(2026, 10, 3, 9, 0).getTime(), now).startsWith('明天'), formatDue(new Date(2026, 10, 3, 9, 0).getTime(), now))
}

// ------------------------------------------------------------------ store
const dir = await mkdtemp(join(tmpdir(), 'dsh-followup-'))
try {
  const store = new TaskStore({ dir })
  await store.ready()
  const task = await store.add({ title: '  看 PR  ', note: '第 11412 号', dueAt: Date.now() + 60_000, source: { sessionId: 's1', cwd: '/tmp/proj' } })
  check('store: 添加并清洗标题', task.title === '看 PR' && task.done === false, JSON.stringify(task))
  check('store: 落盘', JSON.parse(await readFile(join(dir, 'tasks.json'), 'utf8')).tasks.length === 1)

  const updated = await store.update(task.id, { done: true })
  check('store: 标记完成', updated.done === true && typeof updated.doneAt === 'number')

  await store.add({ title: '第二条' })
  await store.remove(task.id)
  check('store: 删除', store.snapshot().length === 1 && store.snapshot()[0].title === '第二条')

  const store2 = new TaskStore({ dir })
  await store2.ready()
  check('store: 重新加载', store2.snapshot().length === 1)

  const priorityTask = await store.add({ title: '很急', priority: 2 })
  check('store: 优先级写入', priorityTask.priority === 2, JSON.stringify(priorityTask.priority))
  const cleared = await store.update(priorityTask.id, { priority: 0 })
  check('store: 优先级清除', cleared.priority === undefined, JSON.stringify(cleared.priority))
} finally {
  await rm(dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------- 宿主半
{
  // 宿主半按 DSH_HOME 找数据目录；测试用临时 home，别碰真实清单。
  const home = await mkdtemp(join(tmpdir(), 'dsh-followup-home-'))
  process.env.DSH_HOME = home
  const sections = []
  const tools = []
  const routes = []
  const effects = []
  const injected = {}
  const ctx = {
    systemPrompt: { section: (options) => { sections.push(options); return () => {} } },
    tools: { register: (tool) => { tools.push(tool); return () => {} } },
    effect: (fn, label) => { effects.push(label); const dispose = fn(); if (typeof dispose === 'function') dispose() },
    inject: (names, callback) => injected[names.join(',')] = callback,
    get: () => undefined,
  }
  apply(ctx)
  check('host: 注册了系统提示段', sections.length === 1 && sections[0].name === 'plugin:dsh-followup', JSON.stringify(sections))
  check('host: 注册了三个工具', tools.length === 3 && tools.map((tool) => tool.name).sort().join(',') === 'followup_add,followup_done,followup_list', tools.map((tool) => tool.name).join(','))
  check('host: 等 webServer 注入', typeof injected['webServer'] === 'function')

  // 工具执行
  const addTool = tools.find((tool) => tool.name === 'followup_add')
  const listTool = tools.find((tool) => tool.name === 'followup_list')
  const doneTool = tools.find((tool) => tool.name === 'followup_done')
  const exec = { agent: { id: 'session-x', session: { header: { cwd: '/Users/robinham/projects/demo' } } } }
  const added = await addTool.execute({ title: '明天看 PR', due: '明天下午3点' }, exec)
  check('tool: followup_add 返回文字', typeof added.text === 'string' && added.text.includes('已记进跟进清单'), added.text)
  const listed = await listTool.execute({}, exec)
  check('tool: followup_list 能看到', listed.text.includes('明天看 PR') && listed.text.includes('明天 15:00'), listed.text)
  const id = storeIdFrom(added.text)
  const done = await doneTool.execute({ id }, exec)
  check('tool: followup_done', done.text.startsWith('已完成：'), done.text)

  // 路由：用假 webServer 捕获 handler，再喂假 req/res
  injected['webServer']({ webServer: { register: (route) => { routes.push(route); return () => {} } }, effect: () => {} })
  check('route: 注册了 /followup 前缀', routes.length === 1 && routes[0].kind === 'prefix' && routes[0].path === '/followup')

  const handler = routes[0].handler
  const listResponse = await callRoute(handler, 'GET', '/followup/list')
  check('route: list', listResponse.status === 200 && Array.isArray(listResponse.body?.value?.tasks), JSON.stringify(listResponse.body).slice(0, 200))

  const addResponse = await callRoute(handler, 'POST', '/followup/add', { title: '记一条', priority: 2 })
  check('route: add', addResponse.status === 200 && addResponse.body.value.task.title === '记一条')
  check('route: add 带优先级', addResponse.body.value.task.priority === 2)

  const priorityResponse = await callRoute(handler, 'POST', '/followup/update', { id: addResponse.body.value.task.id, priority: 1 })
  check('route: update 优先级', priorityResponse.status === 200 && priorityResponse.body.value.task.priority === 1)

  const badResponse = await callRoute(handler, 'POST', '/followup/add', { title: '  ' })
  check('route: 空标题被拒', badResponse.status === 400, JSON.stringify(badResponse.body))

  const missing = await callRoute(handler, 'GET', '/followup/nope')
  check('route: 未知路径 404', missing.status === 404)
  await rm(home, { recursive: true, force: true })
}

/** 从工具文本里取 id。 */
function storeIdFrom(text) {
  const match = String(text).match(/\[?f-[a-z0-9]+-[a-f0-9]+\]?/)
  return match === null ? '' : match[0].replace(/[[\]]/g, '')
}

/** 假 req/res 调 handler。 */
function callRoute(handler, method, url, body) {
  return new Promise((resolve) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
    req.method = method
    req.url = url
    req.headers = { host: '127.0.0.1:55846', 'content-type': 'application/json' }
    const chunks = []
    const res = {
      status: 0,
      headers: {},
      writeHead(status, headers) {
        this.status = status
        this.headers = headers ?? {}
      },
      end(chunk) {
        if (chunk !== undefined) chunks.push(Buffer.from(chunk))
        let parsed = null
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          parsed = null
        }
        resolve({ status: this.status, headers: this.headers, body: parsed })
      },
    }
    Promise.resolve(handler(req, res)).catch((error) => resolve({ status: 500, body: { error: String(error) } }))
  })
}

// ------------------------------------------------------------ 项目 / 会话
{
  const home = await mkdtemp(join(tmpdir(), 'dsh-followup-proj-'))
  const root = await mkdtemp(join(tmpdir(), 'dsh-followup-root-'))
  const project = join(root, 'proj-x')
  await mkdir(project, { recursive: true })
  await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'proj-x', version: '1.6.0', repository: 'https://github.com/acme/proj-x' }))
  const nested = join(root, 'container', 'plugin')
  await mkdir(nested, { recursive: true })
  await writeFile(join(nested, 'package.json'), JSON.stringify({ name: '@acme/nested-usage', version: '1.0.0', description: '侧栏小票机', keywords: ['usage', 'balance'] }))
  await mkdir(join(home, 'storages'), { recursive: true })
  await writeFile(join(home, 'storages', 'workspace.json'), JSON.stringify({
    global: { archivedSessionIds: [] },
    tables: { workspaces: { w1: { path: root } } },
  }))
  process.env.DSH_HOME = home
  // 不联网：网络检查直接失败，走本地事实
  globalThis.fetch = async () => { throw new Error('offline in tests') }

  const projects = new ProjectStore()
  await projects.ready()
  const rows = await projects.list()
  const row = rows.find((item) => item.path === project)
  check('projects: 发现项目', row !== undefined && row.name === 'proj-x' && row.version === '1.6.0', JSON.stringify(rows.map((item) => item.name)))
  const nestedRow = rows.find((item) => item.path === nested)
  check('projects: 发现两层嵌套项目', nestedRow !== undefined && nestedRow.name === 'nested-usage', JSON.stringify(rows.map((item) => item.path)))
  check('projects: 描述/关键词', nestedRow?.description === '侧栏小票机' && nestedRow?.keywords?.includes('usage'), JSON.stringify(nestedRow?.keywords))
  check('projects: 解析 GitHub', row.github?.owner === 'acme' && row.github?.repo === 'proj-x', JSON.stringify(row.github))

  const plain = { version: '0.2.0', facts: { tag: 'v0.1.0', remote: 'https://github.com/acme/x', npm: 'none', market: false, dirty: false }, marks: {} }
  const info = releaseInfo(plain)
  check('release: GitHub 已发版本 + 待迭代', info.channels.github.state === 'on' && info.channels.github.version === '0.1.0' && info.status?.key === 'ahead', JSON.stringify(info))

  const marked = await projects.mark(project, '1.6.0', { devDone: true })
  await projects.mark(project, '1.6.0', { channel: 'github', value: true })
  check('projects: 标记开发完成 + 渠道', channelState(marked).devDone === true && channelState(marked).github === true, JSON.stringify(channelState(marked)))
  const pending = { version: '0.2.0', facts: { tag: undefined, remote: undefined, npm: 'none', market: false, dirty: false }, marks: { '0.2.0': { devDone: true, channels: { market: 'pending' }, at: Date.now() } } }
  const pendingInfo = releaseInfo(pending)
  check('release: 市场审核中', pendingInfo.channels.market.state === 'pending' && pendingInfo.status?.key === 'pending', JSON.stringify(pendingInfo))

  const resolved = projects.resolveSession('s1', { cwd: join(project, 'src'), title: '随便聊聊' })
  check('projects: cwd 绑定', resolved.record?.path === project && resolved.via === 'cwd', JSON.stringify(resolved.via))
  const byTitle = projects.resolveSession('s2', { cwd: '/elsewhere', title: 'proj-x 发布准备' })
  check('projects: 标题绑定', byTitle.record?.path === project && byTitle.via === 'title', JSON.stringify(byTitle.via))
  const byHints = projects.resolveSession('s3', { cwd: '/elsewhere', title: '重做 DSH 用量插件设计', hints: ['usage-card/design-demo.html'] })
  check('projects: 关键词/上下文绑定', byHints.record?.path === nested && byHints.via === 'context', JSON.stringify(byHints))
  const byWorkspace = projects.resolveSession('s4', { cwd: join(root, 'container'), title: '', hints: [] })
  check('projects: 工作区下唯一项目直接锁定', byWorkspace.record?.path === nested && byWorkspace.via === 'cwd', JSON.stringify(byWorkspace))
  const byContext = projects.resolveSession('s4', { cwd: '/elsewhere', title: '随便聊聊', hints: ['我们继续做 proj-x 的 v1.6 发布'] })
  check('projects: 上下文绑定', byContext.record?.path === project && byContext.via === 'context', JSON.stringify(byContext.via))
  const scores = projects.scoreProjects('随便聊聊', ['我们继续做 proj-x 的 v1.6 发布'])
  check('projects: 评分供候选排序', (scores.get(project) ?? 0) >= 2, JSON.stringify([...scores]))
  await projects.bind('s3', project)
  check('projects: 手动绑定', projects.data.sessions.s3.projectPath === project)

  // 会话投影
  const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
  await mkdir(cacheDir, { recursive: true })
  const now = Date.now()
  await writeFile(join(cacheDir, 'sess-a.json'), JSON.stringify({
    version: 7,
    record: {
      identity: { cwd: project },
      rows: {
        title: { val: 'readable-diagrams 发布准备' },
        todos: { val: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }] },
        goal: { val: { current: { goal: { phase: 'active', objective: 'x' } } } },
        userQuestions: { val: { questions: { active: [], settled: [] } } },
        plan: { val: { active: false } },
        agentTeam: { val: { tasks: [{ status: 'in_progress', subject: '华纹纹理层：砖瓦' }] } },
        sessionListMetadata: { val: { blank: false, lastPromptAt: now - 3_600_000 } },
        turnBoundary: { val: { openTurnStartSeq: null } },
        subagent: { val: {} },
      },
    },
  }))
  await writeFile(join(cacheDir, 'sess-b.json'), JSON.stringify({
    version: 7,
    record: {
      identity: { cwd: project },
      rows: {
        title: { val: '很久以前的对话' },
        todos: { val: [{ content: 'c', status: 'pending' }] },
        goal: { val: { current: null } },
        userQuestions: { val: { questions: { active: [], settled: [] } } },
        plan: { val: { active: false } },
        agentTeam: { val: { tasks: [] } },
        sessionListMetadata: { val: { blank: false, lastPromptAt: now - 8 * 86_400_000 } },
        turnBoundary: { val: { openTurnStartSeq: null } },
        subagent: { val: {} },
      },
    },
  }))
  // 真正的子代理会话：有 identity，应被排除
  await writeFile(join(cacheDir, 'sess-child.json'), JSON.stringify({
    version: 7,
    record: {
      identity: { cwd: project },
      rows: {
        title: { val: '子代理' },
        todos: { val: [{ content: 'x', status: 'pending' }] },
        goal: { val: { current: null } },
        userQuestions: { val: { questions: { active: [], settled: [] } } },
        plan: { val: { active: false } },
        agentTeam: { val: { tasks: [{ status: 'in_progress', subject: '华纹纹理层：砖瓦' }] } },
        sessionListMetadata: { val: { blank: false, lastPromptAt: now - 3_600_000 } },
        turnBoundary: { val: { openTurnStartSeq: null } },
        subagent: { val: { identity: { mode: 'continuable', label: 'child' } } },
      },
    },
  }))
  const sessions = new SessionIndex()
  const unfinished = await sessions.unfinished({ ended: {}, now })
  const a = unfinished.find((row) => row.id === 'sess-a')
  const b = unfinished.find((row) => row.id === 'sess-b')
  check('sessions: 未收尾识别', a !== undefined && a.title === 'readable-diagrams 发布准备', JSON.stringify(unfinished.map((row) => row.id)))
  check('sessions: 原因码', a.reasons.some((reason) => reason.code === 'todos' && reason.count === 1) && a.reasons.some((reason) => reason.code === 'goal'), JSON.stringify(a.reasons))
  check('sessions: 7 天没动静 → 休眠', b !== undefined && b.category === 'dormant', JSON.stringify(b?.category))
  check('sessions: 子代理会话排除', unfinished.every((row) => row.id !== 'sess-child'), JSON.stringify(unfinished.map((row) => row.id)))
  check('sessions: 团队任务明细', Array.isArray(a.teamTasks) && a.teamTasks.includes('华纹纹理层：砖瓦'), JSON.stringify(a.teamTasks))

  await projects.ignoreSession('sess-a', a.lastPromptAt)
  const ignoredRows = await sessions.unfinished({ ended: {}, ignored: projects.data.sessions, now })
  check('sessions: 忽略后消失', ignoredRows.every((row) => row.id !== 'sess-a'), JSON.stringify(ignoredRows.map((row) => row.id)))

  const endedRows = await sessions.unfinished({ ended: { 'sess-a': { endedAt: now }, 'sess-b': { endedAt: now } }, now })
  check('sessions: 用户标收尾后消失', endedRows.length === 0)

  await writeFile(join(home, 'storages', 'workspace.json'), JSON.stringify({
    global: { archivedSessionIds: ['sess-a', 'sess-b'] },
    tables: { workspaces: { w1: { path: root } } },
  }))
  await sessions.refresh(true)
  const archivedRows = await sessions.unfinished({ ended: {}, now })
  check('sessions: 归档后消失', archivedRows.length === 0)

  await writeFile(join(home, 'storages', 'schedule.json'), JSON.stringify({
    tables: { tasks: {
      s1: { status: 'active', sessionId: 'sess-a', record: { id: 's1', kind: 'at', title: '检查市场 PR', scheduledAt: new Date(now + 3_600_000).toISOString() } },
      s2: { status: 'active', sessionId: 'sess-b', record: { id: 's2', kind: 'at', title: '提交收录', scheduledAt: new Date(now + 1_800_000).toISOString() } },
      s3: { status: 'inactive', sessionId: 'sess-a', record: { id: 's3', kind: 'after', title: '旧的', scheduledAt: new Date(now - 86_400_000).toISOString() } },
    } },
  }))
  const scheduleIndex = new ScheduleIndex()
  const schedules = await scheduleIndex.list({ get: async () => ({ title: '会话标题' }) })
  check('schedules: 只取 active 且按时间排序', schedules.length === 2 && schedules[0].title === '提交收录' && schedules[0].sessionTitle === '会话标题', JSON.stringify(schedules))

  await rm(home, { recursive: true, force: true })
  await rm(root, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log(failures.join('\n'))
  process.exitCode = 1
}
