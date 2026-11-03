/**
 * 跟进清单的本地存储。
 *
 * 一个 JSON 文件，读一次、写整份、原子替换。没有数据库、没有迁移、没有设置：
 * 数据在 `DSH_HOME/followup/tasks.json`，删掉文件就等于清空。
 *
 * @module dsh-followup/lib/store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

const MAX_TITLE = 200
const MAX_NOTE = 2000
const MAX_TASKS = 800
const KEEP_DONE_DAYS = 30
const DAY = 86_400_000

/** DSH 主目录：DSH_HOME 优先，否则 ~/.dsh。 */
export function dshHome() {
  const override = process.env.DSH_HOME
  return resolve(override !== undefined && override.length > 0 ? override : join(homedir(), '.dsh'))
}

/** 新任务 id。 */
function newId() {
  return `f-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`
}

/** 清洗一句话标题。 */
function cleanTitle(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE)
}

/** 清洗备注。 */
function cleanNote(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/\r\n/g, '\n').trim().slice(0, MAX_NOTE)
}

/** 一条任务是否合法（读盘时用；坏条目直接丢弃，不让整个文件作废）。 */
function isTask(value) {
  return typeof value === 'object' && value !== null
    && typeof value.id === 'string' && value.id.length > 0
    && typeof value.title === 'string' && value.title.length > 0
    && typeof value.createdAt === 'number' && Number.isFinite(value.createdAt)
}

export class TaskStore {
  /**
   * @param {{ dir?: string }} [options]
   */
  constructor(options = {}) {
    this.dir = options.dir ?? join(dshHome(), 'followup')
    this.file = join(this.dir, 'tasks.json')
    this.tasks = []
    this.loaded = false
    /** 串行化写入，避免两次点击互相覆盖。 */
    this.queue = Promise.resolve()
    this.loading = undefined
  }

  /** 只加载一次；并发的调用等同一个 promise。 */
  ready() {
    if (this.loaded) return Promise.resolve(this)
    if (this.loading === undefined) {
      this.loading = this.load().catch((error) => {
        this.loading = undefined
        throw error
      })
    }
    return this.loading
  }

  /** 读盘。文件不存在 = 空清单；文件坏了 = 备份后从空清单开始。 */
  async load() {
    try {
      const text = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(text)
      const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.tasks) ? parsed.tasks : []
      this.tasks = list.filter(isTask).map((task) => ({
        ...task,
        note: typeof task.note === 'string' ? task.note : undefined,
        done: task.done === true,
        updatedAt: typeof task.updatedAt === 'number' ? task.updatedAt : task.createdAt,
      }))
      this.prune()
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        const backup = `${this.file}.corrupt-${Date.now()}`
        try {
          await rename(this.file, backup)
          console.warn(`[dsh-followup] tasks.json 读取失败，已备份到 ${backup}:`, error)
        } catch (renameError) {
          console.warn('[dsh-followup] tasks.json 读取失败，且备份失败:', renameError)
        }
        this.tasks = []
      }
    }
    this.loaded = true
    return this
  }

  /** 写盘（原子替换）。 */
  async save() {
    await mkdir(this.dir, { recursive: true })
    const tmp = `${this.file}.tmp`
    const payload = JSON.stringify({ version: 1, tasks: this.tasks }, null, 2)
    await writeFile(tmp, payload, 'utf8')
    await rename(tmp, this.file)
  }

  /** 串行执行一次修改：确保 ready → 改内存 → 写盘。 */
  mutate(fn) {
    this.queue = this.queue.then(async () => {
      await this.ready()
      const result = await fn()
      this.prune()
      await this.save()
      return result
    })
    return this.queue
  }

  /** 清掉太老的已完成任务，并给总量设上限。 */
  prune(now = Date.now()) {
    const cutoff = now - KEEP_DONE_DAYS * DAY
    this.tasks = this.tasks.filter((task) => !(task.done && (task.doneAt ?? task.updatedAt ?? 0) < cutoff))
    if (this.tasks.length > MAX_TASKS) {
      const done = this.tasks.filter((t) => t.done).sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0))
      const drop = new Set(done.slice(0, this.tasks.length - MAX_TASKS).map((t) => t.id))
      this.tasks = this.tasks.filter((t) => !drop.has(t.id))
    }
  }

  /** 全部任务（副本）。 */
  snapshot() {
    return this.tasks.map((task) => ({ ...task }))
  }

  /** 找一条。 */
  get(id) {
    return this.tasks.find((task) => task.id === id)
  }

  /**
   * 加一条。
   * @param {{ title: string, note?: string, dueAt?: number, source?: { sessionId?: string, cwd?: string } }} input
   */
  add(input) {
    const title = cleanTitle(input.title)
    if (title.length === 0) throw new Error('标题不能为空')
    const now = Date.now()
    const task = {
      id: newId(),
      title,
      note: cleanNote(input.note) || undefined,
      done: false,
      priority: input.priority === 1 || input.priority === 2 ? input.priority : undefined,
      dueAt: typeof input.dueAt === 'number' && Number.isFinite(input.dueAt) ? input.dueAt : undefined,
      source: input.source !== undefined && (input.source.sessionId !== undefined || input.source.cwd !== undefined)
        ? { sessionId: input.source.sessionId, cwd: input.source.cwd }
        : undefined,
      createdAt: now,
      updatedAt: now,
    }
    return this.mutate(() => {
      this.tasks.push(task)
      return task
    })
  }

  /**
   * 改一条。
   * @param {string} id
   * @param {{ title?: string, note?: string, done?: boolean, dueAt?: number | null, snoozedUntil?: number | null }} patch
   */
  update(id, patch) {
    return this.mutate(() => {
      const task = this.get(id)
      if (task === undefined) throw new Error(`没有这条跟进：${id}`)
      if (patch.title !== undefined) {
        const title = cleanTitle(patch.title)
        if (title.length === 0) throw new Error('标题不能为空')
        task.title = title
      }
      if (patch.note !== undefined) task.note = cleanNote(patch.note) || undefined
      if (patch.done !== undefined) {
        task.done = patch.done === true
        if (task.done) task.doneAt = Date.now()
        else delete task.doneAt
      }
      if (patch.priority !== undefined) {
        const priority = patch.priority === 1 || patch.priority === 2 ? patch.priority : 0
        if (priority === 0) delete task.priority
        else task.priority = priority
      }
      if (patch.dueAt !== undefined) {
        task.dueAt = typeof patch.dueAt === 'number' && Number.isFinite(patch.dueAt) ? patch.dueAt : undefined
        if (task.dueAt === undefined) delete task.dueAt
      }
      if (patch.snoozedUntil !== undefined) {
        task.snoozedUntil = typeof patch.snoozedUntil === 'number' && Number.isFinite(patch.snoozedUntil) ? patch.snoozedUntil : undefined
        if (task.snoozedUntil === undefined) delete task.snoozedUntil
      }
      task.updatedAt = Date.now()
      return task
    })
  }

  /** 删一条。 */
  remove(id) {
    return this.mutate(() => {
      const index = this.tasks.findIndex((task) => task.id === id)
      if (index < 0) throw new Error(`没有这条跟进：${id}`)
      const [task] = this.tasks.splice(index, 1)
      return task
    })
  }
}
