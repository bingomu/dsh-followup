/**
 * dsh-followup · 宿主半
 *
 * 全局跟进清单：一个 JSON 文件、三个 agent 工具、四个 HTTP 路由、一段系统提示。
 * 没有设置、没有项目、没有状态机——插件只做一件事：让「还没做完的事」不丢。
 *
 * 导出形状：name / inject / apply，没有 default（跟 dsh-tool-todo 的教训一致）。
 *
 * @module dsh-followup
 */

import { TaskStore } from './lib/store.js'
import { ProjectStore } from './lib/projects.js'
import { SessionIndex } from './lib/sessions.js'
import { ScheduleIndex } from './lib/schedules.js'
import { registerTools } from './lib/tools.js'
import { registerRoutes } from './lib/routes.js'
import { PROMPT_SECTION_NAME, PROMPT_SECTION_ORDER, PROMPT_TEXT } from './lib/prompt.js'

export const name = 'dsh-followup'

/** 工具注册表 + 系统提示装配是硬依赖；webServer 可选（纯 CLI 环境没有）。 */
export const inject = ['tools', 'systemPrompt']

/**
 * 挂载宿主半。
 * @param {*} ctx cordis 插件上下文
 */
export function apply(ctx) {
  const store = new TaskStore()
  const ready = () => store.ready()
  const projects = new ProjectStore()
  const sessions = new SessionIndex()
  const schedules = new ScheduleIndex()

  // 启动就先读一次：坏文件尽早暴露成一条警告，而不是等用户第一次点击。
  ready().catch((error) => {
    console.warn(`[dsh-followup] 清单加载失败（${store.file}）：`, error)
  })
  projects.ready().catch((error) => {
    console.warn('[dsh-followup] 项目台账加载失败：', error)
  })

  try {
    const disposeSection = ctx.systemPrompt.section({
      name: PROMPT_SECTION_NAME,
      order: PROMPT_SECTION_ORDER,
      text: PROMPT_TEXT,
    })
    ctx.effect(() => disposeSection, 'dsh-followup: prompt section')
  } catch (error) {
    console.warn('[dsh-followup] 系统提示段注册失败：', error)
  }

  try {
    const disposers = registerTools(ctx, { store, ready })
    ctx.effect(() => () => {
      for (const dispose of disposers) dispose()
    }, 'dsh-followup: tools')
  } catch (error) {
    console.warn('[dsh-followup] 工具注册失败：', error)
  }

  try {
    ctx.inject(['webServer'], (webCtx) => {
      const dispose = registerRoutes(webCtx, { store, ready, projects, sessions, schedules })
      webCtx.effect(() => dispose, 'dsh-followup: routes')
    })
  } catch (error) {
    console.warn('[dsh-followup] 路由注册失败：', error)
  }
}
