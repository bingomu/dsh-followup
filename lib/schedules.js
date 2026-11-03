/**
 * 定时任务索引：读 DSH 自己的 schedule 存储，把「还在等触发」的任务列出来。
 *
 * 只读，不改任何定时；点击回到它所属的会话，由你自己决定继续还是取消。
 *
 * @module dsh-followup/lib/schedules
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dshHome } from './store.js'

const REFRESH_MS = 20_000

/** 定时任务索引（20 秒缓存）。 */
export class ScheduleIndex {
  constructor(options = {}) {
    this.file = options.file ?? join(dshHome(), 'storages', 'schedule.json')
    this.cache = null
    this.at = 0
  }

  /**
   * 当前 active 的定时任务。
   * @param {{ get: (id: string) => Promise<{ title?: string } | undefined> }} [sessions]
   * @returns {Promise<Array<{ id: string, title: string, kind?: string, at: number | null, sessionId?: string, sessionTitle?: string, prompt?: string }>>}
   */
  async list(sessions) {
    if (this.cache !== null && Date.now() - this.at < REFRESH_MS) return this.cache
    this.at = Date.now()
    let rows = []
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8'))
      const tasks = raw?.tables?.tasks ?? {}
      for (const entry of Object.values(tasks)) {
        if (entry?.status !== 'active') continue
        const record = entry.record ?? {}
        const at = typeof record.scheduledAt === 'string' ? Date.parse(record.scheduledAt) : Number.NaN
        rows.push({
          id: typeof record.id === 'string' ? record.id : 'schedule',
          title: typeof record.title === 'string' && record.title.length > 0 ? record.title : '定时任务',
          kind: typeof record.kind === 'string' ? record.kind : undefined,
          at: Number.isFinite(at) ? at : null,
          sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : undefined,
          prompt: typeof record.prompt === 'string' ? record.prompt.slice(0, 160) : undefined,
        })
      }
    } catch {
      rows = []
    }
    rows.sort((a, b) => (a.at ?? Number.POSITIVE_INFINITY) - (b.at ?? Number.POSITIVE_INFINITY))
    if (sessions !== undefined) {
      for (const row of rows) {
        if (row.sessionId === undefined) continue
        try {
          const info = await sessions.get(row.sessionId)
          if (typeof info?.title === 'string' && info.title.length > 0) row.sessionTitle = info.title
        } catch {
          /* 会话读不到就不带标题 */
        }
      }
    }
    this.cache = rows
    return rows
  }
}
