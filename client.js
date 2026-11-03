/**
 * dsh-followup · 浏览器半
 *
 * 左栏底部一个「跟进」，点开是一张清单：该处理的事在最上面，点一下圆圈
 * 就算做完，点一下正文就跳回它出生的那个对话。没有看板、没有项目、没有
 * 优先级、没有设置页。
 *
 * 清单里的东西主要不是用户建的：宿主半给所有 agent 加了一段系统提示，
 * 用户一句「提醒我」或一轮没收尾，agent 自己会记进来。这里只负责让人看见。
 *
 * @module dsh-followup/client
 */

window.__ModuleLoader__.load({
  id: '@bingomu/dsh-followup',
  factory(require) {
    'use strict'

    const React = require('react')
    let ReactDOM = null
    try { ReactDOM = require('react-dom') } catch { /* 没有就不走 portal */ }

    const DAY = 86_400_000
    const POLL_MS = 30_000
    const STALE_MS = 3 * DAY
    const SR_ONLY = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }

    /** 插件上下文（apply 时拿到），跳会话要用。 */
    let pluginCtx = null
    /** 打开面板时的返回值收集器，避免每次全局查找。 */
    let sheetEls = null
    let sheetOpen = false
    let showDone = false
    let showDormant = false
    let styleInstalled = false

    /** 中英双语的极简词表：只有界面文字，没有设置项。 */
    function lang() {
      const html = String(document.documentElement?.lang || '').toLowerCase()
      if (html.startsWith('zh')) return 'zh'
      const nav = String(navigator.languages?.[0] || navigator.language || '').toLowerCase()
      return nav.startsWith('zh') ? 'zh' : 'en'
    }
    const ZH = {
          entry: '跟进',
          title: '跟进',
          close: '关闭',
          empty: '没有要跟进的事。对话里没做完的，我会自己记下来。',
          emptyHint: '也可以直接在这里记一条。',
          due: '该处理了',
          later: '以后',
          done: '已完成',
          doneToggle: '已完成',
          addPlaceholder: '记一件事，比如「明天下午3点看 PR」',
          addSubmit: '记下',
          jump: '回到原对话',
          remove: '删除',
          markDone: '做完了',
          reopen: '恢复',
          foot: '对话里没做完的，我会自己记下来',
          loadError: '暂时读不到清单，稍后自动重试',
          saved: '记下了',
          count: (n) => `${n} 件待跟进`,
          dueCount: (n) => `${n} 件该处理了`,
          tomorrow: '明天',
          today: '今天',
          justNow: '刚刚',
          hoursAgo: (n) => `${n} 小时前`,
          daysAgo: (n) => `${n} 天前`,
          week: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'],
          tabFollow: '跟进',
          tabProjects: '项目',
          running: '进行中',
          noProjects: '还没发现项目。工作区里带 package.json 或 .git 的目录会自动出现。',
          minutesAgo: (n) => `${n} 分钟前`,
          projectCount: (n) => `${n} 个项目`,
          mark: '标记',
          devDone: '开发完成',
          status: '状态',
          channels: '发布渠道',
          github: 'GitHub',
          npm: 'npm',
          market: 'DSH 市场',
          site: '自己的站',
          pickProject: '选一个项目',
          searchProject: '搜索项目名…',
          guess: '猜你在做',
          noMatch: '没有匹配的项目',
          dirtyTag: '有改动',
          release: '最近发布',
          reviewing: '审核中',
          localVersion: '本地',
          rebind: '换项目',
          noProject: '这个对话还没绑定项目',
          endSession: '这个对话收尾了',
          reopenSession: '重新打开这个对话',
          endedToast: '已标为收尾',
          autoFacts: '自动检测',
          dirty: '有未提交改动',
          ignore: '忽略（有动静再回来）',
          dormantToggle: '休眠',
          ignoredToast: '已忽略，这个对话有新动静时会回来',
          loading: '读取中…',
          scheduled: '定时',
          waiting: '等待触发',
          fromSession: '来自',
          priority: '优先级',
          priorityAuto: '自动',
          priorityHint: '（点击切换）',
          overdue: '逾期',
          todayTag: '今天',
          soonTag: '最近',
          laterTag: '待办',
          importantTag: '重要',
          urgentTag: '紧急',
          waitingTag: '等你',
          doingTag: '进行中',
          plannedTag: '定时',
          dormantTag: '休眠',
        }

    const EN = {
          entry: 'Follow-up',
          title: 'Follow-up',
          close: 'Close',
          empty: 'Nothing to follow up. Unfinished things from chats are recorded here automatically.',
          emptyHint: 'You can also add one right here.',
          due: 'Needs attention',
          later: 'Later',
          done: 'Done',
          doneToggle: 'Done',
          addPlaceholder: 'Add one, e.g. "check the PR tomorrow at 3pm"',
          addSubmit: 'Add',
          jump: 'Back to the conversation',
          remove: 'Remove',
          markDone: 'Done',
          reopen: 'Reopen',
          foot: 'Unfinished things from chats are recorded here automatically',
          loadError: 'Cannot load the list right now — retrying',
          saved: 'Saved',
          count: (n) => `${n} open`,
          dueCount: (n) => `${n} need attention`,
          tomorrow: 'Tomorrow',
          today: 'Today',
          justNow: 'just now',
          hoursAgo: (n) => `${n}h ago`,
          daysAgo: (n) => `${n}d ago`,
          week: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
          tabFollow: 'Follow-up',
          tabProjects: 'Projects',
          running: 'In progress',
          noProjects: 'No projects found yet. Folders with package.json or .git show up here automatically.',
          minutesAgo: (n) => `${n}m ago`,
          projectCount: (n) => `${n} projects`,
          mark: 'Mark',
          devDone: 'Dev done',
          status: 'Status',
          channels: 'Channels',
          github: 'GitHub',
          npm: 'npm',
          market: 'DSH Market',
          site: 'Own site',
          pickProject: 'Pick a project',
          searchProject: 'Search projects…',
          guess: 'Looks like',
          noMatch: 'No matching project',
          dirtyTag: 'dirty',
          release: 'Last release',
          reviewing: 'In review',
          localVersion: 'Local',
          rebind: 'Change',
          noProject: 'This conversation is not bound to a project',
          endSession: 'This conversation is done',
          reopenSession: 'Reopen this conversation',
          endedToast: 'Marked as done',
          autoFacts: 'Detected',
          dirty: 'uncommitted changes',
          ignore: 'Ignore until it moves again',
          dormantToggle: 'Dormant',
          ignoredToast: 'Ignored — it comes back when this conversation moves again',
          loading: 'Loading…',
          scheduled: 'Scheduled',
          waiting: 'waiting',
          fromSession: 'from',
          priority: 'Priority',
          priorityAuto: 'auto',
          priorityHint: ' (click to cycle)',
          overdue: 'Overdue',
          todayTag: 'Today',
          soonTag: 'Soon',
          laterTag: 'Todo',
          importantTag: 'Important',
          urgentTag: 'Urgent',
          waitingTag: 'Waiting',
          doingTag: 'In progress',
          plannedTag: 'Scheduled',
          dormantTag: 'Dormant',
        }

    /** 界面语言：页面 lang 在启动初期可能没落定，所以 apply 时再按宿主的 locale 纠正一次。 */
    let zh = lang() === 'zh'
    let T = zh ? ZH : EN

    function adoptLocale(active) {
      const normalized = typeof active === 'string' ? active.toLowerCase() : ''
      const next = normalized.startsWith('zh') ? true : normalized.startsWith('en') ? false : (lang() === 'zh')
      if (next !== zh) {
        zh = next
        T = zh ? ZH : EN
      }
    }

    // ------------------------------------------------------------------ state

    const state = {
      tasks: [],
      sessions: [],
      schedules: [],
      projects: [],
      tab: 'follow',
      loaded: false,
      error: null,
      projectsError: null,
    }
    const listeners = new Set()

    function emit() {
      for (const listener of listeners) {
        try {
          listener()
        } catch (error) {
          console.warn('[dsh-followup] listener failed', error)
        }
      }
    }

    function subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }

    /** 同源 API 路径（和插件市场一样按 document.baseURI 解析）。 */
    function apiPath(path) {
      const relative = path.replace(/^\/+/, '')
      if (typeof document === 'undefined') return `/${relative}`
      const url = new URL(relative, document.baseURI)
      return url.pathname + url.search
    }

    /** 统一请求：解信封、抛可读错误。 */
    async function request(path, init) {
      const response = await fetch(apiPath(path), {
        cache: 'no-store',
        ...init,
        headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
      })
      const text = await response.text()
      let body
      try {
        body = JSON.parse(text)
      } catch {
        throw new Error(`bad response (HTTP ${response.status})`)
      }
      if (body?.ok !== true) {
        throw new Error(body?.error?.message ?? `request failed (HTTP ${response.status})`)
      }
      return body.value
    }

    async function refresh() {
      const [tasksResult, sessionsResult, schedulesResult] = await Promise.allSettled([
        request('/followup/list'),
        request('/followup/sessions'),
        request('/followup/schedules'),
      ])
      if (tasksResult.status === 'fulfilled') {
        state.tasks = Array.isArray(tasksResult.value?.tasks) ? tasksResult.value.tasks : []
        state.error = null
      } else {
        state.error = tasksResult.reason instanceof Error ? tasksResult.reason.message : String(tasksResult.reason)
      }
      if (sessionsResult.status === 'fulfilled') {
        state.sessions = Array.isArray(sessionsResult.value?.sessions) ? sessionsResult.value.sessions : []
      }
      if (schedulesResult.status === 'fulfilled') {
        state.schedules = Array.isArray(schedulesResult.value?.schedules) ? schedulesResult.value.schedules : []
      }
      state.loaded = true
      emit()
      if (sheetOpen) renderList()
      else maybeToast()
      if (sheetOpen && state.tab === 'projects') void refreshProjects()
    }

    /** 项目页签的数据（只在打开时拉）。 */
    async function refreshProjects() {
      try {
        const value = await request('/followup/projects')
        state.projects = Array.isArray(value?.projects) ? value.projects : []
        state.projectsError = null
      } catch (error) {
        state.projectsError = error instanceof Error ? error.message : String(error)
      }
      emit()
      if (sheetOpen && state.tab === 'projects') renderProjects()
    }

    /** 切换页签：跟进 / 项目。 */
    function setTab(tab) {
      state.tab = tab === 'projects' ? 'projects' : 'follow'
      if (sheetEls !== null) {
        for (const button of sheetEls.tabs.querySelectorAll('[data-tab]')) {
          button.classList.toggle('is-on', button.getAttribute('data-tab') === state.tab)
        }
        sheetEls.form.style.display = state.tab === 'projects' ? 'none' : ''
      }
      if (state.tab === 'projects') void refreshProjects()
      renderList()
    }

    async function addTask(title) {
      const value = await request('/followup/add', {
        method: 'POST',
        body: JSON.stringify({ title }),
      })
      state.tasks = [...state.tasks.filter((task) => task.id !== value?.task?.id), value.task]
      emit()
      if (sheetOpen) renderList()
    }

    async function updateTask(id, patch) {
      const value = await request('/followup/update', {
        method: 'POST',
        body: JSON.stringify({ id, ...patch }),
      })
      state.tasks = state.tasks.map((task) => (task.id === value?.task?.id ? value.task : task))
      emit()
      if (sheetOpen) renderList()
    }

    async function removeTask(id) {
      await request('/followup/remove', { method: 'POST', body: JSON.stringify({ id }) })
      state.tasks = state.tasks.filter((task) => task.id !== id)
      emit()
      if (sheetOpen) renderList()
    }

    // -------------------------------------------------------------- formatting

    function startOfDay(epoch) {
      const date = new Date(epoch)
      date.setHours(0, 0, 0, 0)
      return date.getTime()
    }

    function formatDue(dueAt, now = Date.now()) {
      const date = new Date(dueAt)
      const diff = Math.round((startOfDay(dueAt) - startOfDay(now)) / DAY)
      const hm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
      if (diff === 0) return `${T.today} ${hm}`
      if (diff === 1) return `${T.tomorrow} ${hm}`
      if (diff > 0 && diff < 7) return `${T.week[date.getDay()]} ${hm}`
      return `${date.getMonth() + 1}/${date.getDate()} ${hm}`
    }

    function formatAge(epoch, now = Date.now()) {
      const diff = Math.max(0, now - epoch)
      if (diff < 60_000) return T.justNow
      if (diff < 3_600_000) return T.minutesAgo(Math.floor(diff / 60_000))
      if (diff < DAY) return T.hoursAgo(Math.floor(diff / 3_600_000))
      return T.daysAgo(Math.floor(diff / DAY))
    }

    function isActionable(task, now = Date.now()) {
      if (task.done) return false
      if (typeof task.snoozedUntil === 'number' && task.snoozedUntil > now) return false
      if (typeof task.dueAt === 'number') return task.dueAt <= now
      return now - (task.updatedAt ?? task.createdAt ?? now) > STALE_MS
    }

    /** 便签纸色板：一种颜色对应一种轻重缓急。 */
    const TONE_COLORS = {
      urgent: '#d94a3d',
      overdue: '#d94a3d',
      important: '#d98a2b',
      today: '#e08a3c',
      soon: '#c9a227',
      later: '#3c8a58',
      doing: '#4d6bfe',
      waiting: '#d98a2b',
      planned: '#8b5cf6',
      muted: '#9aa0ae',
      done: '#9aa0ae',
    }

    /** 任务的颜色：手动优先级 > 到期时间 > 搁置。 */
    function taskTone(task, now = Date.now()) {
      if (task.done) return 'done'
      if (task.priority === 2) return 'urgent'
      if (task.priority === 1) return 'important'
      if (typeof task.dueAt === 'number') {
        if (task.dueAt <= now) return 'overdue'
        if (task.dueAt - now <= DAY) return 'today'
        if (task.dueAt - now <= 3 * DAY) return 'soon'
        return 'later'
      }
      if (now - (task.updatedAt ?? task.createdAt ?? now) > STALE_MS) return 'soon'
      return 'later'
    }

    /** 任务右上角的小标签；「待办」不贴标签，留白。 */
    function taskTag(task, now = Date.now()) {
      const tone = taskTone(task, now)
      if (tone === 'urgent') return T.urgentTag
      if (tone === 'important') return T.importantTag
      if (tone === 'overdue') return T.overdue
      if (tone === 'today') return T.todayTag
      if (tone === 'soon') return T.soonTag
      return ''
    }

    function sessionTone(info) {
      if (info.category === 'wait') return 'waiting'
      if (info.category === 'dormant') return 'muted'
      if (info.category === 'running') return 'doing'
      return 'doing'
    }

    function sessionTag(info) {
      if (info.category === 'wait') return T.waitingTag
      if (info.category === 'dormant') return T.dormantTag
      if (info.category === 'running') return T.doingTag
      return T.doingTag
    }

    /** 一行标题：可选彩色便签标签 + 标题。 */
    function titleLine(tagText, nameText) {
      const head = document.createElement('span')
      head.className = 'fu-rowhead'
      if (typeof tagText === 'string' && tagText.length > 0) {
        const tag = document.createElement('span')
        tag.className = 'fu-tag'
        tag.textContent = tagText
        head.appendChild(tag)
      }
      const name = document.createElement('span')
      name.className = 'fu-name'
      name.textContent = nameText
      head.appendChild(name)
      return head
    }

    function openTasks() {
      return state.tasks.filter((task) => !task.done)
    }

    function counts(now = Date.now()) {
      const open = openTasks()
      return {
        open: open.length,
        actionable: open.filter((task) => isActionable(task, now)).length,
      }
    }

    /** 项目名：从会话工作目录的末段取。 */
    function projectName(task) {
      const cwd = task?.source?.cwd
      if (typeof cwd !== 'string' || cwd.length === 0) return ''
      const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/)
      return parts[parts.length - 1] ?? ''
    }

    /** 会话标题（客户端列表里有）；服务没起来就退回项目名。 */
    function sourceLabel(task) {
      const sessionId = task?.source?.sessionId
      if (typeof sessionId === 'string') {
        try {
          const sessions = pluginCtx?.get?.('sessions')
          const title = sessions?.list?.getSnapshot?.()?.byId?.[sessionId]?.displayTitle
          if (typeof title === 'string' && title.length > 0) return title
        } catch {
          /* 服务还没就绪，忽略 */
        }
      }
      return projectName(task)
    }

    /** 一条任务的副标题：来源 + 时间。 */
    function metaLine(task, now = Date.now()) {
      const bits = []
      const label = sourceLabel(task)
      if (label.length > 0) bits.push(label)
      if (!task.done && typeof task.dueAt === 'number') bits.push(formatDue(task.dueAt, now))
      else bits.push(formatAge(task.updatedAt ?? task.createdAt ?? now, now))
      return bits.join(' · ')
    }

    // --------------------------------------------------------------- session

    /** 跳回原对话：0.2.1 的导航入口是 uiWorkspace.openSession。 */
    function openSession(sessionId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return false
      try {
        const nav = pluginCtx?.get?.('uiWorkspace')
        if (nav && typeof nav.openSession === 'function') {
          closeSheet()
          nav.openSession(sessionId)
          return true
        }
        const sessions = pluginCtx?.get?.('sessions')
        if (sessions && typeof sessions.open === 'function') {
          closeSheet()
          sessions.open(sessionId)
          return true
        }
      } catch (error) {
        console.warn('[dsh-followup] 跳转会话失败', error)
      }
      return false
    }

    // ------------------------------------------------------------------ style

    const CSS = `
      .fu-entry{display:flex;align-items:center;gap:8px;flex:1 1 auto;min-width:0;width:100%;padding:5px 7px;border:0;border-radius:8px;
        background:transparent;color:var(--dsw-alias-label-secondary,#6b6f7f);cursor:pointer;font:inherit;
        font-size:12.5px;line-height:1.4;text-align:left;transition:background .16s ease}
      .fu-entry:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
      .fu-entry:active{transform:scale(.99)}
      .fu-entry .fu-entry-icon{flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px}
      .fu-entry .fu-entry-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .fu-entry .fu-entry-badge{flex:none;min-width:17px;height:17px;padding:0 5px;border-radius:999px;background:#d94a3d;color:#fff;
        font-size:10.5px;font-weight:600;line-height:17px;text-align:center;font-variant-numeric:tabular-nums}
      .fu-entry.fu-quiet .fu-entry-badge{background:#8b93a5}
      .fu-entry.fu-collapsed{position:relative;flex:none;width:18px;height:18px;min-width:18px;padding:0;
        justify-content:center;border-radius:6px;margin:0 auto}
      .fu-entry.fu-collapsed .fu-entry-label{display:none}
      .fu-entry.fu-collapsed .fu-entry-badge{position:absolute;top:-4px;right:-5px;min-width:12px;height:12px;
        padding:0 3px;font-size:8.5px;line-height:12px}

      .fu-root{position:fixed;inset:0;z-index:2147482500;pointer-events:none;font-family:inherit}
      .fu-root[data-open="true"]{pointer-events:auto}
      .fu-backdrop{position:absolute;inset:0;background:rgba(16,18,24,.18);opacity:0;transition:opacity .2s ease}
      .fu-root[data-open="true"] .fu-backdrop{opacity:1}
      .fu-sheet{position:absolute;top:0;right:0;bottom:0;width:min(384px,94vw);display:flex;flex-direction:column;
        background:var(--dsw-alias-bg-layer-1,#fff);border-left:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08));
        box-shadow:var(--dsw-shadow-lv3,-24px 0 48px rgba(0,0,0,.18));transform:translateX(102%);
        transition:transform .22s cubic-bezier(.22,.8,.28,1)}
      .fu-root[data-open="true"] .fu-sheet{transform:translateX(0)}
      .fu-head{display:flex;align-items:flex-start;gap:10px;padding:16px 16px 10px 18px}
      .fu-head-main{flex:1;min-width:0}
      .fu-title{font-size:15px;font-weight:650;color:var(--dsw-alias-label-primary,#1f2328);letter-spacing:.01em}
      .fu-sub{margin-top:3px;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8b93a5)}
      .fu-close{flex:none;width:26px;height:26px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-tertiary,#8b93a5);
        font-size:16px;line-height:1;cursor:pointer}
      .fu-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));color:var(--dsw-alias-label-primary,#1f2328)}
      .fu-list{flex:1;min-height:0;overflow:auto;padding:2px 10px 10px}
      .fu-section{margin:16px 8px 6px;font-size:12.5px;font-weight:700;letter-spacing:.01em;
        color:var(--dsw-alias-label-secondary,#4b5162);display:flex;align-items:center;gap:6px}
      .fu-section-count{margin-left:2px;min-width:18px;height:18px;padding:0 5px;border-radius:999px;
        background:var(--dsw-alias-bg-layer-2,#f2f3f5);color:var(--dsw-alias-label-tertiary,#8b93a5);
        font-size:10.5px;font-weight:600;line-height:18px;text-align:center;font-variant-numeric:tabular-nums}
      .fu-dot{width:6px;height:6px;border-radius:50%;background:#d94a3d}
      .fu-empty{padding:36px 22px;text-align:center;color:var(--dsw-alias-label-secondary,#6b6f7f);font-size:12.5px;line-height:1.7}
      .fu-empty-hint{margin-top:8px;color:var(--dsw-alias-label-tertiary,#8b93a5);font-size:11.5px}
      .fu-error{margin:8px 8px 0;padding:7px 10px;border-radius:8px;background:rgba(217,74,61,.08);color:#c0392b;font-size:11.5px}
      .fu-row{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:10px;transition:background .14s ease}
      .fu-row:hover{background-color:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.045))}
      .fu-rowhead{display:flex;align-items:center;gap:6px;min-width:0}
      .fu-rowhead .fu-name{flex:1;min-width:0}
      .fu-tag{flex:none;font-size:9.5px;line-height:1.7;padding:0 6px;border-radius:4px;
        background:var(--fu-tint,rgba(0,0,0,.06));color:var(--fu-tone,#6b6f7f);font-weight:650;letter-spacing:.02em;white-space:nowrap}
      .fu-flag{font-size:12px}
      .fu-flag[data-p="1"]{color:#d98a2b}
      .fu-flag[data-p="2"]{color:#d94a3d}
      .fu-row[data-tone],.fu-srow[data-tone]{background-image:linear-gradient(90deg,var(--fu-tint),transparent 74%);
        box-shadow:inset 3px 0 0 var(--fu-tone)}
      .fu-row[data-tone="urgent"],.fu-srow[data-tone="urgent"]{--fu-tone:#d94a3d;--fu-tint:rgba(217,74,61,.10)}
      .fu-row[data-tone="overdue"],.fu-srow[data-tone="overdue"]{--fu-tone:#d94a3d;--fu-tint:rgba(217,74,61,.08)}
      .fu-row[data-tone="important"],.fu-srow[data-tone="important"]{--fu-tone:#d98a2b;--fu-tint:rgba(217,138,43,.10)}
      .fu-row[data-tone="today"],.fu-srow[data-tone="today"]{--fu-tone:#e08a3c;--fu-tint:rgba(224,138,60,.10)}
      .fu-row[data-tone="soon"],.fu-srow[data-tone="soon"]{--fu-tone:#c9a227;--fu-tint:rgba(201,162,39,.10)}
      .fu-row[data-tone="later"],.fu-srow[data-tone="later"]{--fu-tone:#3c8a58;--fu-tint:rgba(60,138,88,.08)}
      .fu-srow[data-tone="doing"]{--fu-tone:#4d6bfe;--fu-tint:rgba(77,107,254,.09)}
      .fu-srow[data-tone="waiting"]{--fu-tone:#d98a2b;--fu-tint:rgba(217,138,43,.10)}
      .fu-srow[data-tone="planned"]{--fu-tone:#8b5cf6;--fu-tint:rgba(139,92,246,.09)}
      .fu-srow[data-tone="muted"],.fu-row[data-tone="done"]{--fu-tone:#9aa0ae;--fu-tint:rgba(154,160,174,.06)}
      .fu-row[data-due="true"] .fu-tick{border-color:#d94a3d}
      .fu-tick{flex:none;width:18px;height:18px;border:1.4px solid var(--dsw-alias-border-l2,#b9bfcc);border-radius:50%;
        background:transparent;color:#fff;cursor:pointer;padding:0;display:grid;place-items:center;transition:all .14s ease}
      .fu-tick:hover{border-color:#3c8a58;background:rgba(60,138,88,.12)}
      .fu-tick svg{opacity:0;transition:opacity .14s ease}
      .fu-row[data-done="true"] .fu-tick{background:#3c8a58;border-color:#3c8a58}
      .fu-row[data-done="true"] .fu-tick svg{opacity:1}
      .fu-main{flex:1;min-width:0;border:0;background:transparent;padding:0;text-align:left;cursor:pointer;font:inherit;color:inherit;display:block}
      .fu-main.fu-static{cursor:default}
      .fu-name{display:block;font-size:13px;line-height:1.45;color:var(--dsw-alias-label-primary,#1f2328);
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .fu-row[data-done="true"] .fu-name{color:var(--dsw-alias-label-tertiary,#8b93a5);text-decoration:line-through;text-decoration-thickness:1px}
      .fu-meta{display:block;margin-top:2px;font-size:10.8px;color:var(--dsw-alias-label-tertiary,#8b93a5);
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .fu-actions{flex:none;display:flex;align-items:center;gap:2px;opacity:0;transition:opacity .14s ease}
      .fu-row:hover .fu-actions{opacity:1}
      .fu-act{width:24px;height:24px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#8b93a5);
        cursor:pointer;padding:0;display:grid;place-items:center;font-size:12px}
      .fu-act:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#1f2328)}
      .fu-done-toggle{margin:8px 8px 0;border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#8b93a5);
        font-size:11px;cursor:pointer;padding:3px 4px;border-radius:6px}
      .fu-done-toggle:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
      .fu-add{display:flex;align-items:center;gap:6px;padding:10px 12px;border-top:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08))}
      .fu-input{flex:1;min-width:0;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));
        border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary,#1f2328);font:inherit;font-size:12.5px;outline:none}
      .fu-input:focus{border-color:var(--dsw-alias-interactive-bg-hover-accent,#4d6bfe)}
      .fu-input::placeholder{color:var(--dsw-alias-label-tertiary,#8b93a5)}
      .fu-submit{flex:none;height:32px;padding:0 12px;border:0;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f2f3f5);
        color:var(--dsw-alias-label-secondary,#6b6f7f);font:inherit;font-size:12px;cursor:pointer}
      .fu-submit:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.08))}
      .fu-foot{padding:0 12px 12px;text-align:center;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8b93a5)}
      .fu-tabs{display:flex;gap:2px;padding:0 14px 8px}
      .fu-tab{border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#8b93a5);font:inherit;font-size:12px;
        padding:5px 10px;border-radius:7px;cursor:pointer}
      .fu-tab:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
      .fu-tab.is-on{background:var(--dsw-alias-bg-layer-2,#f2f3f5);color:var(--dsw-alias-label-primary,#1f2328);font-weight:600}

      .fu-srow{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:10px;transition:background .14s ease}
      .fu-srow:hover{background-color:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.045))}
      .fu-srow:hover .fu-actions{opacity:1}
      .fu-sdot{flex:none;width:7px;height:7px;border-radius:50%;background:#b9bfcc}
      .fu-sdot[data-cat="wait"]{background:#d94a3d}
      .fu-sdot[data-cat="running"]{background:#4d6bfe}
      .fu-sdot[data-cat="idle"]{background:#c2c7d2}
      .fu-sclock{flex:none;width:18px;text-align:center;font-size:12px;color:var(--dsw-alias-label-tertiary,#8b93a5)}
      .fu-submeta{display:block;margin-top:1px;font-size:10.2px;color:var(--dsw-alias-label-tertiary,#8b93a5);
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

      .fu-prow{display:flex;flex-direction:column;gap:5px;padding:9px 8px;border-radius:10px}
      .fu-prow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
      .fu-phead{display:flex;align-items:baseline;gap:8px}
      .fu-pname{flex:1;min-width:0;font-size:12.8px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2328);
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .fu-pver{flex:none;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8b93a5);font-variant-numeric:tabular-nums}
      .fu-pmeta{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8b93a5)}

      .fu-chip{display:inline-flex;align-items:center;font-size:10.5px;padding:2px 7px;border-radius:999px;
        border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));color:var(--dsw-alias-label-tertiary,#8b93a5);
        white-space:nowrap;font:inherit;font-size:10.5px}
      .fu-chips button.fu-chip{background:transparent;cursor:pointer}
      .fu-chip.on{border-color:rgba(60,138,88,.38);background:rgba(60,138,88,.12);color:#2f6b45}

      .fu-hbadge{display:inline-flex;align-items:center;gap:6px;height:26px;max-width:190px;padding:0 9px;border-radius:999px;
        border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08));background:var(--dsw-alias-bg-layer-1,#fff);
        color:var(--dsw-alias-label-secondary,#6b6f7f);font:inherit;font-size:11.5px;cursor:pointer}
      .fu-hbadge:hover{background:var(--dsw-alias-bg-layer-2,#f7f8fa)}
      .fu-hbadge .fu-hdot{flex:none;width:6px;height:6px;border-radius:50%;background:#b9bfcc}
      .fu-hbadge-on .fu-hdot{background:#3c8a58}
      .fu-hbadge-quiet .fu-hdot{background:#c9cdd6}
      .fu-hbadge .fu-hlabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

      .fu-pop{position:fixed;z-index:2147482700;width:min(370px,92vw);max-height:min(520px,80vh);overflow:auto;padding:12px;
        border-radius:14px;border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08));background:var(--dsw-alias-bg-layer-1,#fff);
        color:var(--dsw-alias-label-primary,#1f2328);box-shadow:var(--dsw-shadow-lv3,0 18px 44px rgba(0,0,0,.18));
        font:inherit;font-size:12.5px}
      .fu-pop-head{display:flex;align-items:baseline;gap:7px}
      .fu-pop-name{flex:1;min-width:0;font-weight:650;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .fu-pop-ver{flex:none;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8b93a5)}
      .fu-pop-link{flex:none;border:0;background:transparent;color:#4d6bfe;font:inherit;font-size:10.5px;cursor:pointer;padding:0}
      .fu-pop-label{margin:11px 0 6px;font-size:10px;letter-spacing:.07em;color:var(--dsw-alias-label-tertiary,#8b93a5)}
      .fu-pop-status{display:flex;align-items:center;gap:8px;margin-top:7px;font-size:11px;
        color:var(--dsw-alias-label-tertiary,#8b93a5)}
      .fu-pop-local{font-variant-numeric:tabular-nums}
      .fu-status{font-size:10px;line-height:1.7;padding:0 6px;border-radius:4px;font-weight:650;white-space:nowrap}
      .fu-status-dirty{background:rgba(201,162,39,.16);color:#8a6a12}
      .fu-status-ahead{background:rgba(224,138,60,.14);color:#a35f10}
      .fu-status-ready{background:rgba(77,107,254,.10);color:#3b57c9}
      .fu-status-released{background:rgba(60,138,88,.12);color:#2f6b45}
      .fu-status-pending{background:rgba(201,162,39,.16);color:#8a6a12}
      .fu-chip.pending{background:rgba(201,162,39,.12);border-color:rgba(201,162,39,.35);color:#8a6a12}
      .fu-pop-facts{margin-top:10px;font-size:10.3px;color:var(--dsw-alias-label-tertiary,#8b93a5);line-height:1.5}
      .fu-pop-end{margin-top:9px;width:100%;padding:6px;border-radius:8px;border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08));
        background:transparent;color:var(--dsw-alias-label-secondary,#6b6f7f);font:inherit;font-size:11.5px;cursor:pointer}
      .fu-pop-end:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
      .fu-pick-search{position:sticky;top:0;z-index:1;width:100%;height:30px;margin:2px 0 8px;padding:0 9px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));
        border-radius:7px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);font:inherit;font-size:12px;outline:none;box-sizing:border-box}
      .fu-pick-search:focus{border-color:var(--dsw-alias-interactive-bg-hover-accent,#4d6bfe)}
      .fu-pick-search::placeholder{color:var(--dsw-alias-label-tertiary,#8b93a5)}
      .fu-pick-dirty{flex:none;font-size:9.5px;line-height:1.7;padding:0 5px;border-radius:4px;
        background:rgba(201,162,39,.16);color:#8a6a12;white-space:nowrap}
      .fu-pick-release{flex:none;font-size:9.5px;line-height:1.7;padding:0 5px;border-radius:4px;
        background:rgba(77,107,254,.10);color:#3b57c9;white-space:nowrap}
      .fu-pick-guess{background:rgba(60,138,88,.08);border:1px solid rgba(60,138,88,.22)}
      .fu-pick-guess:hover{background:rgba(60,138,88,.13)}
      .fu-picker{display:flex;flex-direction:column;gap:1px;max-height:200px;overflow:auto;margin-top:2px}
      .fu-pick{display:flex;align-items:center;gap:8px;border:0;background:transparent;border-radius:7px;padding:6px 7px;
        font:inherit;font-size:12px;color:var(--dsw-alias-label-primary,#1f2328);cursor:pointer;text-align:left}
      .fu-pick:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
      .fu-pick-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .fu-pick small{color:var(--dsw-alias-label-tertiary,#8b93a5);font-size:10px}
      @keyframes fu-pop-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}

      .fu-flash{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147482800;padding:8px 14px;
        border-radius:999px;background:rgba(24,26,32,.88);color:#fff;font:inherit;font-size:12px;
        animation:fu-toast-in .18s ease}
      .fu-flash-out{opacity:0;transition:opacity .2s ease}

      .fu-toast{position:fixed;right:16px;top:56px;z-index:2147482400;display:flex;align-items:center;gap:8px;
        max-width:min(360px,80vw);padding:10px 13px;border-radius:12px;border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08));
        background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);cursor:pointer;
        box-shadow:var(--dsw-shadow-lv3,0 12px 32px rgba(0,0,0,.18));font:inherit;font-size:12.5px;text-align:left;
        animation:fu-toast-in .22s cubic-bezier(.22,.8,.28,1)}
      .fu-toast:hover{background:var(--dsw-alias-bg-layer-2,#f7f8fa)}
      .fu-toast .fu-toast-dot{flex:none;width:7px;height:7px;border-radius:50%;background:#d94a3d}
      .fu-toast .fu-toast-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .fu-toast .fu-toast-go{flex:none;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8b93a5)}
      .fu-toast.fu-toast-out{opacity:0;transform:translateY(-6px);transition:opacity .25s ease,transform .25s ease}
      @keyframes fu-toast-in{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}
    `

    function installStyle() {
      if (styleInstalled) return
      styleInstalled = true
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-followup'
      tag.dataset.pluginCss = 'dsh-followup:sheet'
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ------------------------------------------------------------------ sheet

    function ensureSheet() {
      if (sheetEls !== null) return sheetEls
      installStyle()
      const root = document.createElement('div')
      root.className = 'fu-root'
      root.dataset.open = 'false'
      root.innerHTML = `
        <div class="fu-backdrop" data-act="backdrop"></div>
        <aside class="fu-sheet" role="dialog" aria-label="${T.title}" aria-modal="true">
          <header class="fu-head">
            <div class="fu-head-main">
              <div class="fu-title">${T.title}</div>
              <div class="fu-sub" data-el="sub"></div>
            </div>
            <button class="fu-close" data-act="close" title="${T.close}" aria-label="${T.close}">×</button>
          </header>
          <div class="fu-tabs" data-el="tabs">
            <button type="button" class="fu-tab is-on" data-tab="follow">${T.tabFollow}</button>
            <button type="button" class="fu-tab" data-tab="projects">${T.tabProjects}</button>
          </div>
          <div class="fu-list" data-el="list"></div>
          <form class="fu-add" data-el="form">
            <input class="fu-input" data-el="input" type="text" maxlength="200" autocomplete="off"
              placeholder="${T.addPlaceholder}" aria-label="${T.addPlaceholder}" />
            <button class="fu-submit" type="submit">${T.addSubmit}</button>
          </form>
          <div class="fu-foot">${T.foot}</div>
        </aside>
      `
      document.body.appendChild(root)

      const els = {
        root,
        backdrop: root.querySelector('[data-act="backdrop"]'),
        close: root.querySelector('[data-act="close"]'),
        sub: root.querySelector('[data-el="sub"]'),
        list: root.querySelector('[data-el="list"]'),
        tabs: root.querySelector('[data-el="tabs"]'),
        form: root.querySelector('[data-el="form"]'),
        input: root.querySelector('[data-el="input"]'),
      }

      els.backdrop.addEventListener('click', closeSheet)
      els.close.addEventListener('click', closeSheet)
      els.tabs.addEventListener('click', (event) => {
        const tab = event.target.closest?.('[data-tab]')?.getAttribute('data-tab')
        if (tab !== null && tab !== undefined) setTab(tab)
      })
      els.form.addEventListener('submit', async (event) => {
        event.preventDefault()
        const title = els.input.value.trim()
        if (title.length === 0) return
        els.input.value = ''
        try {
          await addTask(title)
        } catch (error) {
          els.input.value = title
          console.warn('[dsh-followup] 添加失败', error)
        }
      })
      // 列表用事件委托：行是每次重渲染出来的。
      els.list.addEventListener('click', async (event) => {
        const sessionRow = event.target.closest?.('.fu-srow')
        if (sessionRow !== null && sessionRow !== undefined) {
          const ignoreClick = event.target.closest?.('[data-act="ignore-session"]')
          if (ignoreClick !== null && ignoreClick !== undefined) {
            const sessionId = sessionRow.getAttribute('data-session')
            const info = state.sessions.find((item) => item.id === sessionId)
            try {
              await request('/followup/session/ignore', {
                method: 'POST',
                body: JSON.stringify({ sessionId, promptAt: info?.lastPromptAt }),
              })
              state.sessions = state.sessions.filter((item) => item.id !== sessionId)
              emit()
              renderList()
              flash(T.ignoredToast)
            } catch (error) {
              console.warn('[dsh-followup] 忽略失败', error)
            }
            return
          }
          openSession(sessionRow.getAttribute('data-session'))
          return
        }
        const row = event.target.closest?.('.fu-row')
        if (row === null || row === undefined) return
        const id = row.getAttribute('data-id')
        const task = state.tasks.find((item) => item.id === id)
        if (task === undefined) return
        const act = event.target.closest?.('[data-act]')?.getAttribute('data-act') ?? ''
        try {
          if (act === 'tick') {
            await updateTask(id, { done: !task.done })
          } else if (act === 'priority') {
            const next = (task.priority ?? 0) >= 2 ? 0 : (task.priority ?? 0) + 1
            await updateTask(id, { priority: next })
          } else if (act === 'remove') {
            await removeTask(id)
          } else if (act === 'jump') {
            openSession(task.source?.sessionId)
          } else if (act === 'body') {
            if (task.done) return
            openSession(task.source?.sessionId)
          }
        } catch (error) {
          console.warn('[dsh-followup] 操作失败', error)
        }
      })
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && sheetOpen) {
          event.stopPropagation()
          closeSheet()
        }
      }, true)

      sheetEls = els
      return els
    }

    function tickSvg() {
      return '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-6.5"/></svg>'
    }

    function makeRow(task, now) {
      const row = document.createElement('div')
      row.className = 'fu-row'
      row.setAttribute('data-id', task.id)
      row.setAttribute('data-due', String(!task.done && typeof task.dueAt === 'number' && task.dueAt <= now))
      row.setAttribute('data-done', String(task.done === true))
      row.setAttribute('data-tone', taskTone(task, now))

      const tick = document.createElement('button')
      tick.className = 'fu-tick'
      tick.type = 'button'
      tick.dataset.act = 'tick'
      tick.title = task.done ? T.reopen : T.markDone
      tick.setAttribute('aria-label', tick.title)
      tick.innerHTML = tickSvg()
      row.appendChild(tick)

      const main = document.createElement('button')
      main.type = 'button'
      main.className = 'fu-main' + (task.source?.sessionId === undefined ? ' fu-static' : '')
      main.dataset.act = 'body'
      main.title = task.source?.sessionId === undefined ? task.title : `${task.title}\n${T.jump}`
      const meta = document.createElement('span')
      meta.className = 'fu-meta'
      meta.textContent = metaLine(task, now)
      main.appendChild(titleLine(task.done ? '' : taskTag(task, now), task.title))
      main.appendChild(meta)
      row.appendChild(main)

      const actions = document.createElement('span')
      actions.className = 'fu-actions'
      if (!task.done) {
        const flag = document.createElement('button')
        flag.type = 'button'
        flag.className = 'fu-act fu-flag'
        flag.dataset.act = 'priority'
        flag.dataset.p = String(task.priority ?? 0)
        flag.title = `${T.priority}: ${task.priority === 2 ? T.urgentTag : task.priority === 1 ? T.importantTag : T.priorityAuto}${T.priorityHint}`
        flag.setAttribute('aria-label', flag.title)
        flag.textContent = '⚑'
        actions.appendChild(flag)
      }
      if (task.source?.sessionId !== undefined && !task.done) {
        const jump = document.createElement('button')
        jump.type = 'button'
        jump.className = 'fu-act'
        jump.dataset.act = 'jump'
        jump.title = T.jump
        jump.setAttribute('aria-label', T.jump)
        jump.textContent = '↗'
        actions.appendChild(jump)
      }
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'fu-act'
      remove.dataset.act = 'remove'
      remove.title = T.remove
      remove.setAttribute('aria-label', T.remove)
      remove.textContent = '×'
      actions.appendChild(remove)
      row.appendChild(actions)
      return row
    }

    function sectionLabel(text, tone, count) {
      const label = document.createElement('div')
      label.className = 'fu-section'
      if (typeof tone === 'string' && tone.length > 0) {
        const dot = document.createElement('span')
        dot.className = 'fu-dot'
        dot.style.background = TONE_COLORS[tone] ?? '#8b93a5'
        label.appendChild(dot)
      }
      label.appendChild(document.createTextNode(text))
      if (typeof count === 'number' && Number.isFinite(count) && count > 0) {
        const badge = document.createElement('span')
        badge.className = 'fu-section-count'
        badge.textContent = String(count)
        label.appendChild(badge)
      }
      return label
    }

    function renderList() {
      if (sheetEls === null) return
      if (state.tab === 'projects') {
        renderProjects()
        return
      }
      const { list, sub } = sheetEls
      const now = Date.now()
      const open = openTasks()
      const actionable = open.filter((task) => isActionable(task, now))
        .sort((a, b) => {
          const ad = typeof a.dueAt === 'number' ? a.dueAt : Number.POSITIVE_INFINITY
          const bd = typeof b.dueAt === 'number' ? b.dueAt : Number.POSITIVE_INFINITY
          return ad - bd || (a.updatedAt ?? 0) - (b.updatedAt ?? 0)
        })
      const later = open.filter((task) => !isActionable(task, now))
        .sort((a, b) => {
          const ad = typeof a.dueAt === 'number' ? a.dueAt : Number.POSITIVE_INFINITY
          const bd = typeof b.dueAt === 'number' ? b.dueAt : Number.POSITIVE_INFINITY
          return ad - bd || (b.createdAt ?? 0) - (a.createdAt ?? 0)
        })
      const done = state.tasks.filter((task) => task.done)
        .sort((a, b) => (b.doneAt ?? b.updatedAt ?? 0) - (a.doneAt ?? a.updatedAt ?? 0))
      const dormantSessions = state.sessions.filter((info) => info.category === 'dormant')
      const activeSessions = state.sessions.filter((info) => info.category !== 'dormant')
      const waitSessions = activeSessions.filter((info) => info.category === 'wait')
      const liveSessions = activeSessions.filter((info) => info.category !== 'wait')

      const bits = []
      if (open.length > 0) bits.push(T.count(open.length))
      if (liveSessions.length > 0) bits.push(`${liveSessions.length} ${T.running}`)
      if (state.schedules.length > 0) bits.push(`${state.schedules.length} ${T.scheduled}`)
      sub.textContent = bits.join(' · ')

      list.textContent = ''
      if (state.error !== null) {
        const error = document.createElement('div')
        error.className = 'fu-error'
        error.textContent = T.loadError
        list.appendChild(error)
      }
      if (!state.loaded) {
        const loading = document.createElement('div')
        loading.className = 'fu-empty'
        loading.textContent = '…'
        list.appendChild(loading)
        return
      }
      const empty = open.length === 0 && waitSessions.length === 0 && liveSessions.length === 0 && state.schedules.length === 0
      if (empty) {
        const box = document.createElement('div')
        box.className = 'fu-empty'
        box.textContent = T.empty
        const hint = document.createElement('div')
        hint.className = 'fu-empty-hint'
        hint.textContent = T.emptyHint
        box.appendChild(hint)
        list.appendChild(box)
      }
      if (actionable.length > 0 || waitSessions.length > 0) {
        list.appendChild(sectionLabel(T.due, 'urgent', actionable.length + waitSessions.length))
        for (const task of actionable) list.appendChild(makeRow(task, now))
        for (const info of waitSessions) list.appendChild(sessionRow(info))
      }
      if (liveSessions.length > 0) {
        list.appendChild(sectionLabel(T.running, 'doing', liveSessions.length))
        for (const info of liveSessions) list.appendChild(sessionRow(info))
      }
      if (state.schedules.length > 0) {
        list.appendChild(sectionLabel(T.scheduled, 'planned', state.schedules.length))
        for (const item of state.schedules) list.appendChild(scheduleRow(item))
      }
      if (later.length > 0) {
        list.appendChild(sectionLabel(T.later, 'later', later.length))
        for (const task of later) list.appendChild(makeRow(task, now))
      }
      if (dormantSessions.length > 0) {
        const toggle = document.createElement('button')
        toggle.type = 'button'
        toggle.className = 'fu-done-toggle'
        toggle.textContent = `${T.dormantToggle} ${dormantSessions.length}`
        toggle.addEventListener('click', () => {
          showDormant = !showDormant
          renderList()
        })
        list.appendChild(toggle)
        if (showDormant) {
          for (const info of dormantSessions) list.appendChild(sessionRow(info))
        }
      }
      if (done.length > 0) {
        const toggle = document.createElement('button')
        toggle.type = 'button'
        toggle.className = 'fu-done-toggle'
        toggle.textContent = `${T.doneToggle} ${done.length}`
        toggle.addEventListener('click', () => {
          showDone = !showDone
          renderList()
        })
        list.appendChild(toggle)
        if (showDone) {
          for (const task of done.slice(0, 80)) list.appendChild(makeRow(task, now))
        }
      }
    }

    /** 自动收进来的会话：一条一行，点回原对话。 */
    function sessionRow(info) {
      const row = document.createElement('div')
      row.className = 'fu-srow'
      row.setAttribute('data-session', info.id)
      row.setAttribute('data-tone', sessionTone(info))
      const main = document.createElement('button')
      main.type = 'button'
      main.className = 'fu-main'
      const meta = document.createElement('span')
      meta.className = 'fu-meta'
      const bits = []
      if (Array.isArray(info.reasons) && info.reasons.length > 0) bits.push(info.reasons.join(' · '))
      if (typeof info.lastPromptAt === 'number') bits.push(formatAge(info.lastPromptAt))
      meta.textContent = bits.join(' · ')
      main.appendChild(titleLine(sessionTag(info), info.title))
      main.appendChild(meta)
      if (Array.isArray(info.teamTasks) && info.teamTasks.length > 0) {
        const sub = document.createElement('span')
        sub.className = 'fu-submeta'
        sub.textContent = `${zh ? '团队' : 'Team'}：${info.teamTasks.join('、')}`
        main.appendChild(sub)
      }
      row.appendChild(main)
      const actions = document.createElement('span')
      actions.className = 'fu-actions'
      const ignore = document.createElement('button')
      ignore.type = 'button'
      ignore.className = 'fu-act'
      ignore.setAttribute('data-act', 'ignore-session')
      ignore.title = T.ignore
      ignore.setAttribute('aria-label', T.ignore)
      ignore.textContent = '×'
      actions.appendChild(ignore)
      row.appendChild(actions)
      return row
    }

    /** 项目页签。 */
    function renderProjects() {
      if (sheetEls === null) return
      const { list, sub } = sheetEls
      sub.textContent = T.projectCount(state.projects.length)
      list.textContent = ''
      if (state.projectsError !== null) {
        const error = document.createElement('div')
        error.className = 'fu-error'
        error.textContent = state.projectsError
        list.appendChild(error)
      }
      if (state.projects.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'fu-empty'
        empty.textContent = T.noProjects
        list.appendChild(empty)
        return
      }
      for (const project of state.projects) list.appendChild(projectRow(project))
    }

    /** 定时任务：只读，点一下回到它所属的会话。 */
    function scheduleRow(item) {
      const row = document.createElement('div')
      row.className = 'fu-srow'
      row.setAttribute('data-tone', 'planned')
      if (typeof item.sessionId === 'string') row.setAttribute('data-session', item.sessionId)
      const clock = document.createElement('span')
      clock.className = 'fu-sclock'
      clock.textContent = '◷'
      const main = document.createElement('button')
      main.type = 'button'
      main.className = 'fu-main'
      const meta = document.createElement('span')
      meta.className = 'fu-meta'
      const bits = [item.at !== null && item.at !== undefined ? formatDue(item.at) : T.waiting]
      if (typeof item.sessionTitle === 'string' && item.sessionTitle.length > 0) bits.push(`${T.fromSession} ${item.sessionTitle}`)
      meta.textContent = bits.join(' · ')
      main.appendChild(titleLine(T.plannedTag, item.title))
      main.appendChild(meta)
      row.appendChild(clock)
      row.appendChild(main)
      return row
    }

    function projectRow(project) {
      const row = document.createElement('div')
      row.className = 'fu-prow'
      const head = document.createElement('div')
      head.className = 'fu-phead'
      const name = document.createElement('span')
      name.className = 'fu-pname'
      name.textContent = project.name ?? project.dir ?? project.path
      head.appendChild(name)
      if (typeof project.version === 'string' && project.version.length > 0) {
        const version = document.createElement('span')
        version.className = 'fu-pver'
        version.textContent = `v${project.version}`
        head.appendChild(version)
      }
      const chips = document.createElement('div')
      chips.className = 'fu-chips'
      if (project.channel?.devDone === true) {
        const chip = document.createElement('span')
        chip.className = 'fu-chip on'
        chip.textContent = `✓ ${T.devDone}`
        chips.appendChild(chip)
      }
      for (const [key, label] of [['github', T.github], ['npm', T.npm], ['market', T.market], ['site', T.site]]) {
        const chip = document.createElement('span')
        chip.className = 'fu-chip' + (project.channel?.[key] ? ' on' : '')
        chip.textContent = label
        chips.appendChild(chip)
      }
      const meta = document.createElement('div')
      meta.className = 'fu-pmeta'
      const bits = []
      if (typeof project.facts?.lastCommit === 'string') {
        const time = Date.parse(project.facts.lastCommit)
        if (Number.isFinite(time)) bits.push(formatAge(time))
      }
      if (typeof project.facts?.tag === 'string') bits.push(project.facts.tag)
      if (project.facts?.dirty === true) bits.push(T.dirty)
      meta.textContent = bits.join(' · ')
      row.appendChild(head)
      row.appendChild(chips)
      if (meta.textContent.length > 0) row.appendChild(meta)
      return row
    }

    function openSheet() {
      const els = ensureSheet()
      sheetOpen = true
      els.root.dataset.open = 'true'
      renderList()
      void refresh()
      // 打开时把焦点给输入框，键盘用户可以直接记一条。
      setTimeout(() => {
        try {
          els.input.focus({ preventScroll: true })
        } catch {
          /* 忽略 */
        }
      }, 60)
    }

    function closeSheet() {
      if (sheetEls === null) return
      sheetOpen = false
      sheetEls.root.dataset.open = 'false'
    }

    function toggleSheet() {
      if (sheetOpen) closeSheet()
      else openSheet()
    }

    // 到点/搁置的轻提示：每次页面加载最多一条，点一下进面板，8 秒自己走。
    let toastShown = false
    function maybeToast() {
      if (toastShown || sheetOpen || document.visibilityState === 'hidden') return
      const { actionable } = counts()
      if (actionable === 0) return
      toastShown = true
      const toast = document.createElement('button')
      toast.type = 'button'
      toast.className = 'fu-toast'
      toast.title = T.entry
      const dot = document.createElement('span'); dot.className = 'fu-toast-dot'
      const text = document.createElement('span'); text.className = 'fu-toast-text'
      text.textContent = T.dueCount(actionable)
      const go = document.createElement('span'); go.className = 'fu-toast-go'
      go.textContent = zh ? '看看' : 'View'
      toast.appendChild(dot); toast.appendChild(text); toast.appendChild(go)
      toast.addEventListener('click', () => {
        toast.remove()
        openSheet()
      })
      document.body.appendChild(toast)
      setTimeout(() => {
        toast.classList.add('fu-toast-out')
        setTimeout(() => toast.remove(), 300)
      }, 8000)
    }

    // ------------------------------------------------------------- footer 入口

    /** 左栏底部的入口：宽屏是「跟进 + 数字」，收窄成一个图标 + 角标。 */
    function Entry(props) {
      const [, force] = React.useState(0)
      React.useEffect(() => subscribe(() => force((value) => value + 1)), [])
      const total = counts()
      const wide = props?.wide !== false
      const hasDue = total.actionable > 0
      return React.createElement(
        'button',
        {
          type: 'button',
          className: `fu-entry${hasDue ? '' : ' fu-quiet'}${wide ? '' : ' fu-collapsed'}`,
          title: hasDue ? `${T.entry} · ${T.dueCount(total.actionable)}` : T.entry,
          'aria-label': T.entry,
          onClick: toggleSheet,
        },
        React.createElement(
          'span',
          { className: 'fu-entry-icon' },
          React.createElement(
            'svg',
            { viewBox: '0 0 16 16', width: wide ? 15 : 14, height: wide ? 15 : 14, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', 'aria-hidden': true },
            React.createElement('path', { d: 'M3 4.2h10M3 8h10M3 11.8h6.2' }),
          ),
        ),
        wide ? React.createElement('span', { className: 'fu-entry-label' }, T.entry) : null,
        total.open > 0
          ? React.createElement('span', { className: 'fu-entry-badge' }, String(hasDue ? total.actionable : total.open))
          : null,
      )
    }

    // ------------------------------------------------------- 对话 header 标记

    /** 每个会话最近一次的标记数据，切换会话时不闪。 */
    const headerCache = new Map()

    /** 项目元信息缓存（旧宿主没有 lastActive/dirty 时从 /followup/projects 补）。 */
    let projectMetaCache = { at: 0, map: new Map() }

    async function projectMetaMap() {
      if (Date.now() - projectMetaCache.at < 60_000) return projectMetaCache.map
      try {
        const value = await request('/followup/projects')
        const map = new Map()
        for (const project of value?.projects ?? []) {
          const time = typeof project.lastActive === 'number'
            ? project.lastActive
            : typeof project.facts?.lastCommit === 'string' ? Date.parse(project.facts.lastCommit) : Number.NaN
          const channel = project.channel ?? {}
          const manual = Object.entries(project.mark?.channels ?? {}).filter(([, on]) => on === true)
          const manualLabel = manual.length > 0
            ? ({ github: 'GitHub', npm: 'npm', market: '市场', site: '自己的站' })[manual[0][0]] ?? null
            : null
          const label = project.release?.label
            ?? manualLabel
            ?? (channel.site === true ? '自己的站' : channel.market === true ? '市场' : channel.npm === true ? 'npm' : channel.github === true ? 'GitHub' : null)
          map.set(project.path, {
            lastActive: Number.isFinite(time) ? time : undefined,
            dirty: project.dirty === true || project.facts?.dirty === true,
            release: project.release ?? (label !== null ? { label, channel: null, at: null, source: 'auto' } : null),
          })
        }
        projectMetaCache = { at: Date.now(), map }
      } catch {
        /* 没拿到就保持旧的 */
      }
      return projectMetaCache.map
    }

    /** 底部中间的小提示（标记成功 / 收尾）。 */
    function flash(text) {
      const el = document.createElement('div')
      el.className = 'fu-flash'
      el.textContent = text
      document.body.appendChild(el)
      setTimeout(() => {
        el.classList.add('fu-flash-out')
        setTimeout(() => el.remove(), 240)
      }, 1800)
    }

    /** 自动检测到的事实，一行灰字。 */
    function autoFactsText(facts) {
      const bits = []
      if (typeof facts?.tag === 'string' && facts.tag.length > 0) bits.push(`tag ${facts.tag}`)
      if (facts?.npm === 'none') bits.push(zh ? 'npm 未发' : 'npm none')
      else if (typeof facts?.npm === 'string' && facts.npm.length > 0) bits.push(`npm ${facts.npm}`)
      if (facts?.market === true) bits.push(zh ? '市场已收录' : 'market listed')
      else if (facts?.market === false) bits.push(zh ? '市场未收录' : 'market not listed')
      if (facts?.dirty === true) bits.push(T.dirty)
      return `${T.autoFacts}: ${bits.length > 0 ? bits.join(' · ') : '—'}`
    }

    /** 弹层内容。 */
    function buildHeaderPopover(options) {
      const { project, channel, data, busy, picker, pos, popRef } = options
      const releases = project?.releases ?? null
      const children = []
      children.push(React.createElement('div', { className: 'fu-pop-head', key: 'head' },
        React.createElement('span', { className: 'fu-pop-name' }, project !== null ? project.name : (data === null ? T.loading : T.noProject)),
        project !== null && typeof project.version === 'string'
          ? React.createElement('span', { className: 'fu-pop-ver' }, `v${project.version}`)
          : null,
        project !== null
          ? React.createElement('button', {
              type: 'button',
              className: 'fu-pop-link',
              onClick: options.onTogglePicker,
            }, picker ? T.close : T.rebind)
          : null,
      ))

      const releaseLabelOf = (item) => item?.release?.label
        ?? (typeof item?.release === 'string' ? item.release : null)
      const releaseChip = (item) => {
        const label = releaseLabelOf(item)
        return label === null || label === undefined
          ? null
          : React.createElement('span', {
              className: 'fu-pick-release',
              title: `${T.release}：${label}`,
            }, `↑ ${label}`)
      }
      const dirtyChip = (item) => item?.dirty === true
        ? React.createElement('span', { className: 'fu-pick-dirty', title: T.dirty }, T.dirtyTag)
        : null

      if (project !== null) {
        const status = releases?.status ?? null
        children.push(React.createElement('div', { className: 'fu-pop-status', key: 'pstatus' },
          React.createElement('span', { className: 'fu-pop-local' },
            `${T.localVersion} ${typeof releases?.local === 'string' && releases.local.length > 0 ? `v${releases.local}` : (typeof project.version === 'string' ? `v${project.version}` : '—')}`),
          status !== null
            ? React.createElement('span', { className: `fu-status fu-status-${status.key}` }, status.label)
            : null,
        ))
      }

      const all = Array.isArray(data?.candidates) ? data.candidates : []
      const query = typeof options.query === 'string' ? options.query : ''
      const needle = query.trim().toLowerCase()
      const filtered = needle.length === 0
        ? all
        : all.filter((candidate) => `${candidate.name ?? ''} ${candidate.path ?? ''}`.toLowerCase().includes(needle))
      const guess = needle.length === 0 ? (data?.guess ?? null) : null
      const guessEl = guess === null
        ? null
        : React.createElement('div', { key: 'guess' },
            React.createElement('div', { className: 'fu-pop-label' }, T.guess),
            React.createElement('button', {
              type: 'button',
              className: 'fu-pick fu-pick-guess',
              disabled: busy,
              onClick: () => options.onBind(guess.path),
            },
              React.createElement('span', { className: 'fu-pick-name' }, guess.name),
              releaseChip(guess),
              React.createElement('small', null, [typeof guess.version === 'string' ? `v${guess.version}` : '', typeof guess.lastActive === 'number' ? formatAge(guess.lastActive) : ''].filter(Boolean).join(' · ')),
              dirtyChip(guess),
            ),
          )
      const pickerEl = React.createElement('div', { className: 'fu-picker', key: 'picker' },
        React.createElement('input', {
          key: 'search',
          className: 'fu-pick-search',
          type: 'text',
          value: query,
          placeholder: T.searchProject,
          autoFocus: true,
          onChange: (event) => options.onQuery(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter' && filtered.length > 0) options.onBind(filtered[0].path)
          },
        }),
        guessEl,
        React.createElement('div', { key: 'label', className: 'fu-pop-label' },
          needle.length === 0 ? `${T.pickProject} · ${all.length}` : `${T.pickProject} · ${filtered.length}`),
        filtered.length === 0
          ? React.createElement('div', { key: 'empty', className: 'fu-pop-facts' }, data === null ? T.loading : T.noMatch)
          : filtered.slice(0, 12).map((candidate) => React.createElement('button', {
              type: 'button',
              key: candidate.path,
              className: 'fu-pick',
              title: candidate.name,
              disabled: busy,
              onClick: () => options.onBind(candidate.path),
            },
              React.createElement('span', { className: 'fu-pick-name' }, candidate.name),
              releaseChip(candidate),
              React.createElement('small', null, [typeof candidate.version === 'string' ? `v${candidate.version}` : '', typeof candidate.lastActive === 'number' ? formatAge(candidate.lastActive) : ''].filter(Boolean).join(' · ')),
              dirtyChip(candidate),
            )),
      )

      if (project === null || picker) {
        children.push(React.createElement('div', { className: 'fu-pop-label', key: 'picklabel' }, project === null ? T.pickProject : T.rebind))
        children.push(pickerEl)
      }

      if (project !== null && !picker) {
        children.push(React.createElement('div', { className: 'fu-pop-label', key: 'l1' }, T.status))
        children.push(React.createElement('div', { className: 'fu-chips', key: 'c1' },
          React.createElement('button', {
            type: 'button',
            className: 'fu-chip' + (channel.devDone ? ' on' : ''),
            disabled: busy,
            onClick: () => options.onMark({ devDone: !channel.devDone }),
          }, (channel.devDone ? '✓ ' : '') + T.devDone),
        ))
        children.push(React.createElement('div', { className: 'fu-pop-label', key: 'l2' }, T.channels))
        children.push(React.createElement('div', { className: 'fu-chips', key: 'c2' },
          ['github', 'npm', 'market', 'site'].map((key) => {
            const info = releases?.channels?.[key] ?? { state: channel[key] ? 'on' : 'off', version: null }
            const label = info.state === 'pending'
              ? `${T[key]} · ${T.reviewing}`
              : info.state === 'on' && typeof info.version === 'string' && info.version.length > 0
                ? `✓ ${T[key]} v${info.version}`
                : (info.state === 'on' ? '✓ ' : '') + T[key]
            const next = key === 'market'
              ? (info.state === 'off' ? 'pending' : info.state === 'pending' ? true : false)
              : info.state !== 'on'
            return React.createElement('button', {
              type: 'button',
              key,
              className: 'fu-chip' + (info.state === 'on' ? ' on' : '') + (info.state === 'pending' ? ' pending' : ''),
              disabled: busy,
              onClick: () => options.onMark({ channel: key, value: next }),
            }, label)
          }),
        ))
        children.push(React.createElement('div', { className: 'fu-pop-facts', key: 'facts' }, autoFactsText(project.facts)))
        children.push(React.createElement('button', {
          type: 'button',
          className: 'fu-pop-end',
          key: 'end',
          disabled: busy,
          onClick: options.onEnd,
        }, T.endSession))
        if (data?.session?.endedAt !== null && data?.session?.endedAt !== undefined) {
          children.push(React.createElement('button', {
            type: 'button',
            className: 'fu-pop-end',
            key: 'reopen',
            disabled: busy,
            onClick: options.onReopen,
          }, T.reopenSession))
        }
      }

      return React.createElement('div', {
        className: 'fu-pop',
        ref: popRef,
        style: { top: `${pos.top}px`, right: `${pos.right}px` },
      }, children)
    }

    /** 对话右上角的标记入口：项目 + 版本，点开一键标记。 */
    function HeaderMark(props) {
      const sessionId = props?.sessionId
      const [data, setData] = React.useState(() => (typeof sessionId === 'string' ? headerCache.get(sessionId) : undefined) ?? null)
      const [open, setOpen] = React.useState(false)
      const [picker, setPicker] = React.useState(false)
      const [query, setQuery] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [pos, setPos] = React.useState({ top: 64, right: 16 })
      const buttonRef = React.useRef(null)
      const popRef = React.useRef(null)
      const [, force] = React.useState(0)
      React.useEffect(() => subscribe(() => force((value) => value + 1)), [])

      const load = React.useCallback(async () => {
        if (typeof sessionId !== 'string' || sessionId.length === 0) return
        try {
          let value = await request(`/followup/session?session=${encodeURIComponent(sessionId)}`)
          const needsMeta = [...(value?.candidates ?? []), value?.guess]
            .filter((item) => item !== null && item !== undefined)
            .some((item) => typeof item.lastActive !== 'number' || typeof item.dirty !== 'boolean' || item.release === undefined)
          if (needsMeta) {
            const meta = await projectMetaMap()
            const attach = (item) => {
              if (item === null || item === undefined) return item
              const info = meta.get(item.path)
              if (info === undefined) return item
              return {
                ...item,
                lastActive: typeof item.lastActive === 'number' ? item.lastActive : info.lastActive,
                dirty: typeof item.dirty === 'boolean' ? item.dirty : info.dirty,
                release: item.release ?? info.release ?? null,
              }
            }
            value = {
              ...value,
              candidates: (value?.candidates ?? []).map(attach),
              guess: attach(value?.guess),
            }
          }
          headerCache.set(sessionId, value)
          setData(value)
        } catch (error) {
          console.warn('[dsh-followup] 读取标记失败', error)
        }
      }, [sessionId])

      React.useEffect(() => { void load() }, [load])

      React.useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => {
          if (popRef.current?.contains(event.target)) return
          if (buttonRef.current?.contains(event.target)) return
          setOpen(false)
        }
        const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
        document.addEventListener('mousedown', onDown, true)
        document.addEventListener('keydown', onKey, true)
        return () => {
          document.removeEventListener('mousedown', onDown, true)
          document.removeEventListener('keydown', onKey, true)
        }
      }, [open])

      const project = data?.project ?? null
      const channel = project?.channel ?? {}
      const version = project?.version

      const act = async (patch) => {
        if (project === null || busy) return
        setBusy(true)
        try {
          const value = await request('/followup/mark', {
            method: 'POST',
            body: JSON.stringify({ path: project.path, version, ...patch }),
          })
          const next = { ...(data ?? {}), project: value.project }
          headerCache.set(sessionId, next)
          setData(next)
          state.projects = state.projects.map((item) => (item.path === value.project.path ? value.project : item))
          emit()
          if (sheetOpen) renderList()
        } catch (error) {
          console.warn('[dsh-followup] 标记失败', error)
        } finally {
          setBusy(false)
        }
      }

      const bind = async (path) => {
        setBusy(true)
        try {
          const value = await request('/followup/bind', {
            method: 'POST',
            body: JSON.stringify({ sessionId, path }),
          })
          const next = { ...(data ?? {}), project: value.project, via: 'bound' }
          headerCache.set(sessionId, next)
          setData(next)
          setPicker(false)
          setQuery('')
          if (sheetOpen) void refreshProjects()
        } catch (error) {
          console.warn('[dsh-followup] 绑定项目失败', error)
        } finally {
          setBusy(false)
        }
      }

      const endSession = async () => {
        setBusy(true)
        try {
          await request('/followup/end-session', {
            method: 'POST',
            body: JSON.stringify({ sessionId }),
          })
          setOpen(false)
          flash(T.endedToast)
          void refresh()
        } catch (error) {
          console.warn('[dsh-followup] 标记收尾失败', error)
        } finally {
          setBusy(false)
        }
      }

      const reopen = async () => {
        setBusy(true)
        try {
          await request('/followup/end-session', {
            method: 'POST',
            body: JSON.stringify({ sessionId, reopen: true }),
          })
          const next = { ...(data ?? {}), session: { ...(data?.session ?? {}), endedAt: null } }
          headerCache.set(sessionId, next)
          setData(next)
          flash(zh ? '已重新打开' : 'Reopened')
          void refresh()
        } catch (error) {
          console.warn('[dsh-followup] 重新打开失败', error)
        } finally {
          setBusy(false)
        }
      }

      const toggle = () => {
        if (!open && buttonRef.current !== null) {
          const rect = buttonRef.current.getBoundingClientRect()
          const height = 340
          const top = rect.bottom + 8 + height > window.innerHeight ? Math.max(8, rect.top - height - 8) : rect.bottom + 8
          setPos({ top, right: Math.max(10, window.innerWidth - rect.right) })
        }
        if (!open) {
          setPicker(false)
          setQuery('')
          void load()
        }
        setOpen(!open)
      }

      const label = project === null
        ? T.mark
        : `${project.name ?? ''}${typeof version === 'string' && version.length > 0 ? ` v${version}` : ''}`
      const anyChannel = ['github', 'npm', 'market', 'site'].some((key) => channel[key] === true)
      const ended = data?.session?.endedAt !== null && data?.session?.endedAt !== undefined

      const content = buildHeaderPopover({
        project,
        channel,
        data,
        busy,
        picker,
        pos,
        popRef,
        onTogglePicker: () => {
          setPicker((value) => !value)
          setQuery('')
        },
        query,
        onQuery: setQuery,
        onMark: act,
        onBind: bind,
        onEnd: endSession,
        onReopen: reopen,
      })

      return React.createElement(
        React.Fragment,
        null,
        React.createElement('button', {
          type: 'button',
          ref: buttonRef,
          className: `fu-hbadge${project === null ? ' fu-hbadge-quiet' : anyChannel || channel.devDone ? ' fu-hbadge-on' : ''}`,
          title: project === null ? T.noProject : `${project.name}${ended ? ` · ${T.endedToast}` : ''}`,
          onClick: toggle,
        },
          React.createElement('span', { className: 'fu-hdot' }),
          React.createElement('span', { className: 'fu-hlabel' }, label),
        ),
        open && ReactDOM !== null
          ? ReactDOM.createPortal(content, document.body)
          : null,
      )
    }

    // ---------------------------------------------------------------- apply

    let pollTimer = null

    /** 屏幕外的标签页不轮询；回来时立刻补一次。 */
    function startPolling() {
      if (pollTimer !== null) return
      void refresh()
      pollTimer = setInterval(() => {
        if (document.visibilityState === 'hidden') return
        void refresh()
      }, POLL_MS)
      document.addEventListener('visibilitychange', onVisible)
    }

    function onVisible() {
      if (document.visibilityState === 'visible') void refresh()
    }

    function stopPolling() {
      if (pollTimer !== null) {
        clearInterval(pollTimer)
        pollTimer = null
      }
      document.removeEventListener('visibilitychange', onVisible)
      if (sheetEls !== null) {
        sheetEls.root.remove()
        sheetEls = null
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        pluginCtx = ctx
        installStyle()

        try {
          const locale = ctx.get?.('locale')
          adoptLocale(locale?.getSnapshot?.().active)
          if (typeof locale?.subscribe === 'function') {
            ctx.effect(() => locale.subscribe(() => {
              adoptLocale(locale.getSnapshot?.().active)
              emit()
              if (sheetEls !== null) {
                const wasOpen = sheetOpen
                sheetEls.root.remove()
                sheetEls = null
                sheetOpen = false
                if (wasOpen) openSheet()
              }
            }), 'dsh-followup: locale')
          }
        } catch (error) {
          console.warn('[dsh-followup] locale 跟随失败', error)
        }
        // locale 服务可能晚一步就绪：再补一次（只改语言，不动数据）
        if (ctx.get?.('locale') === undefined) {
          setTimeout(() => {
            try {
              adoptLocale(ctx.get?.('locale')?.getSnapshot?.().active)
              emit()
            } catch { /* 忽略 */ }
          }, 700)
        }

        try {
          ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
            { name: 'sidebar.footer.action', id: 'dsh-followup', order: 90, label: T.entry },
            (props) => React.createElement(Entry, { wide: props?.wide }),
          ))
        } catch (error) {
          console.warn('[dsh-followup] 左栏入口注册失败', error)
        }

        try {
          ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
            name: 'conversation.session.header.utilities',
            id: 'dsh-followup-mark',
            order: 60,
            label: T.mark,
            inject: (sessionId) => ({ sessionId }),
          }, HeaderMark))
        } catch (error) {
          console.warn('[dsh-followup] header 标记注册失败', error)
        }

        startPolling()
        ctx.effect(() => () => stopPolling(), 'dsh-followup: polling')
      },
    }
  },
})
