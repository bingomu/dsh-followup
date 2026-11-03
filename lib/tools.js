/**
 * 三个 agent 工具：记一条、查清单、关一条。
 *
 * 工具结果直接渲染成模型能读的一段话（output.render），不依赖 SDK 的
 * defineTool——宿主半刻意不 import @deepseek-ai/*，理由和 dsh-taskboard 一样：
 * profile 里若出现同名的 SDK 包会遮蔽宿主内置版本，把整个 base 层弄坏。
 *
 * @module dsh-followup/lib/tools
 */

import { formatDue, parseDue } from './dates.js'

/** 工具参数：对象根、additionalProperties 关闭。 */
function schema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false }
}

/** 从工具执行上下文里拿调用方会话。 */
function callerOf(exec) {
  const agent = exec?.agent
  const sessionId = typeof agent?.id === 'string' ? agent.id : undefined
  const cwd = typeof agent?.session?.header?.cwd === 'string' ? agent.session.header.cwd : undefined
  return {
    source: sessionId !== undefined || cwd !== undefined ? { sessionId, cwd } : undefined,
  }
}

/** 一行任务摘要。 */
function line(task, index) {
  const bits = []
  if (task.dueAt !== undefined) bits.push(`截止 ${formatDue(task.dueAt)}`)
  if (task.done) bits.push('已完成')
  const suffix = bits.length > 0 ? `（${bits.join(' · ')}）` : ''
  const status = task.done ? '✓' : '○'
  return `${index + 1}. ${status} ${task.title}${suffix}  [${task.id}]`
}

/**
 * 注册三个工具。
 * @param {*} ctx 插件上下文（需已 inject 'tools'）
 * @param {{ store: import('./store.js').TaskStore, ready: () => Promise<unknown> }} deps
 * @returns {Array<() => void>} disposers
 */
export function registerTools(ctx, deps) {
  const { store, ready } = deps
  const disposers = []

  disposers.push(ctx.tools.register({
    name: 'followup_add',
    description:
      '把一件需要跟进的事记进全局跟进清单（跨会话，用户在任何对话都能看到）。'
      + '用户说「提醒我 / 记一下 / 回头弄 / 别忘了」时直接调用，不要反问。'
      + 'title 用一句话讲清要做什么；有日期就传 due，例如「明天下午3点」「周五」「3天后」「2026-11-03 10:00」。',
    parameters: schema({
      title: { type: 'string', description: '要跟进的事，一句话（不超过 200 字）。' },
      due: { type: 'string', description: '可选的时间说法，自然语言或 ISO 都行。' },
      note: { type: 'string', description: '可选的补充说明。' },
      priority: { type: 'number', description: '可选优先级：1 重要，2 紧急（用户说「很重要 / 很急」时传）。' },
    }, ['title']),
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: value.text }] },
    async execute(args, exec) {
      await ready()
      const title = typeof args?.title === 'string' ? args.title : ''
      if (title.trim().length === 0) throw new Error('title 不能为空')
      const parsed = typeof args?.due === 'string' && args.due.trim().length > 0 ? parseDue(args.due) : null
      const task = await store.add({
        title,
        note: typeof args?.note === 'string' ? args.note : undefined,
        priority: args?.priority === 1 || args?.priority === 2 ? args.priority : undefined,
        dueAt: parsed?.dueAt,
        ...callerOf(exec),
      })
      const when = parsed !== null ? `，截止 ${formatDue(parsed.dueAt)}` : ''
      return { text: `已记进跟进清单：${task.title}${when}（id ${task.id}）` }
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'followup_list',
    description: '列出全局跟进清单里的未完成事项（可选包含已完成）。需要拿 id 去关闭某条时先调用它。',
    parameters: schema({
      includeDone: { type: 'boolean', description: '是否连已完成的也列出来，默认 false。' },
    }),
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: value.text }] },
    async execute(args) {
      await ready()
      const includeDone = args?.includeDone === true
      const tasks = store.snapshot().filter((task) => includeDone || !task.done)
      if (tasks.length === 0) return { text: '跟进清单是空的。' }
      return { text: [`跟进清单 ${tasks.length} 条：`, ...tasks.map(line)].join('\n') }
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'followup_done',
    description: '把一条跟进标记为完成（用户说「那件事做完了」时用）。不知道 id 就先 followup_list。',
    parameters: schema({
      id: { type: 'string', description: '任务 id，形如 f-xxxxx-xxxx。' },
    }, ['id']),
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: value.text }] },
    async execute(args) {
      await ready()
      const id = typeof args?.id === 'string' ? args.id.trim() : ''
      if (id.length === 0) throw new Error('id 不能为空')
      const task = await store.update(id, { done: true })
      return { text: `已完成：${task.title}（${task.id}）` }
    },
  }))

  return disposers
}
