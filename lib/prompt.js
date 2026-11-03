/**
 * 给所有 agent 的一段系统提示。
 *
 * 目的只有一个：让「跟进」这件事不需要用户开口——用户随口一句「提醒我」
 * 或一轮结束时留着尾巴，agent 自己就记了。
 *
 * @module dsh-followup/lib/prompt
 */

export const PROMPT_SECTION_NAME = 'plugin:dsh-followup'

/** 工具指引带（100–199）里靠后的位置。 */
export const PROMPT_SECTION_ORDER = 185

export const PROMPT_TEXT = [
  '全局跟进清单（dsh-followup）：本机有一个跨会话的跟进清单，工具 followup_add / followup_list / followup_done，',
  '用户在任何对话里都能看到同一份清单。',
  '- 用户说「提醒我 / 记一下 / 回头弄 / 别忘了 / 明天再说 / 之后再看」时，直接 followup_add 记下，不要反问、不要确认、不要写成 markdown 文件。',
  '- 一轮结束时若还有明确未完成、下一轮要继续的事，也 followup_add 记一条：一句话讲清「要做什么」；有日期就传 due（如「明天下午3点」「周五」「3天后」「2026-11-03 10:00」）。',
  '- 用户说某件事做完了，用 followup_done 关掉；不知道 id 就先 followup_list。',
  '- 只记真正需要跟进的：不记琐事、不记本轮已完成的事、不记用户明确说不用管的。',
  '- 用户说「很重要 / 很急」时，followup_add 传 priority=1（重要）或 2（紧急）。',
].join('\n')
