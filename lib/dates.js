/**
 * 说人话的日期解析。
 *
 * 输入是用户或模型随手写的一句时间：「明天下午三点」「周五」「3 天后」
 * 「2026-11-03 10:00」「今晚」。解析不出来就返回 null——宁可不设时间，
 * 也不要猜错一个提醒。
 *
 * @module dsh-followup/lib/dates
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const CN_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
const WEEKDAY_INDEX = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 }

/** 把 0–59 的中文/阿拉伯数字转成 int；失败返回 NaN。 */
function smallNumber(text) {
  if (typeof text !== 'string' || text.length === 0) return Number.NaN
  if (/^\d{1,2}$/.test(text)) return Number(text)
  if (text.length === 1) return text === '十' ? 10 : (CN_DIGIT[text] ?? Number.NaN)
  if (text.length === 2) {
    if (text[0] === '十') return 10 + (CN_DIGIT[text[1]] ?? 0)
    if (text[1] === '十') return (CN_DIGIT[text[0]] ?? 0) * 10
    return Number.NaN
  }
  if (text.length === 3 && text[1] === '十') {
    return (CN_DIGIT[text[0]] ?? 0) * 10 + (CN_DIGIT[text[2]] ?? 0)
  }
  return Number.NaN
}

/** 当天 0 点。 */
function dayStart(epoch) {
  const d = new Date(epoch)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 在指定日期上定一个时刻。 */
function at(dayEpoch, hour, minute) {
  const d = new Date(dayEpoch)
  d.setHours(hour, minute, 0, 0)
  return d.getTime()
}

/**
 * 解析一句时间。
 *
 * @param {string} text 用户/模型写的时间短语。
 * @param {number} [now] 参考时刻（默认当前）。
 * @returns {{ dueAt: number, hour: number, minute: number, explicitTime: boolean } | null}
 */
export function parseDue(text, now = Date.now()) {
  if (typeof text !== 'string') return null
  let raw = text.trim()
  if (raw.length === 0 || raw.length > 120) return null
  raw = raw.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
  raw = raw.replace(/\s+/g, ' ')

  // 1) ISO / 常见数字日期：2026-11-03、2026/11/03 10:00、11-03
  const iso = raw.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ](\d{1,2})[:：](\d{2}))?/)
  if (iso !== null) {
    const [, y, mo, d, h, mi] = iso
    const base = new Date(Number(y), Number(mo) - 1, Number(d), 0, 0, 0, 0)
    if (Number.isNaN(base.getTime())) return null
    const hasTime = h !== undefined
    const hour = hasTime ? Number(h) : 9
    const minute = hasTime ? Number(mi) : 0
    return { dueAt: at(base.getTime(), hour, minute), hour, minute, explicitTime: hasTime }
  }

  const base = dayStart(now)
  const weekday = new Date(now).getDay() // 0=周日
  const isoWeekday = weekday === 0 ? 7 : weekday

  // 2) 时间部分：上午/下午/晚上 + N 点 [N 分]
  let hour = Number.NaN
  let minute = 0
  let explicitTime = false
  let period = ''
  const periodMatch = raw.match(/(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里|今晚|明晚|今早|明早)/)
  if (periodMatch !== null) period = periodMatch[1]

  const timeMatch = raw.match(/(\d{1,2}|[零〇一二两三四五六七八九十]{1,3})\s*[点時时:：]\s*(半|一刻|\d{1,2}|[零〇一二两三四五六七八九十]{1,3})?\s*分?/)
  if (timeMatch !== null) {
    const h = smallNumber(timeMatch[1])
    if (Number.isFinite(h) && h >= 0 && h <= 24) {
      hour = h
      const mark = timeMatch[2]
      if (mark === '半') minute = 30
      else if (mark === '一刻') minute = 15
      else {
        const m = mark === undefined ? 0 : smallNumber(mark)
        minute = Number.isFinite(m) && m >= 0 && m <= 59 ? m : 0
      }
      explicitTime = true
    }
  }
  if (explicitTime) {
    if ((period === '下午' || period === '傍晚' || period === '晚上' || period === '夜里' || period === '今晚' || period === '明晚') && hour < 12) hour += 12
    if (period === '中午' && hour < 11) hour += 12
    if (hour === 24) hour = 0
  }

  // 3) 日期部分
  let dayEpoch = Number.NaN
  if (/大后天/.test(raw)) dayEpoch = base + 3 * DAY
  else if (/后天/.test(raw)) dayEpoch = base + 2 * DAY
  else if (/明天|明日|明早|明晚|明儿/.test(raw)) dayEpoch = base + DAY
  else if (/今天|今日|今早|今晚|今儿/.test(raw)) dayEpoch = base
  else if (/下周([一二三四五六日天])/.test(raw)) {
    const target = WEEKDAY_INDEX[raw.match(/下周([一二三四五六日天])/)[1]]
    const ahead = (target - isoWeekday + 7) % 7
    dayEpoch = base + (ahead === 0 ? 7 : ahead) * DAY
  } else if (/(周|星期|礼拜)([一二三四五六日天])/.test(raw)) {
    const target = WEEKDAY_INDEX[raw.match(/(周|星期|礼拜)([一二三四五六日天])/)[2]]
    const ahead = (target - isoWeekday + 7) % 7
    dayEpoch = base + (ahead === 0 && !explicitTime ? 7 : ahead) * DAY
  } else {
    const inDays = raw.match(/(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*天\s*(?:后|以后|之后)/)
    if (inDays !== null) {
      const n = smallNumber(inDays[1])
      if (Number.isFinite(n) && n >= 0 && n <= 365) dayEpoch = base + n * DAY
    }
  }

  // 只有时间没有日期：今天，已过就明天
  if (Number.isNaN(dayEpoch) && explicitTime) {
    dayEpoch = base
    const candidate = at(dayEpoch, hour, minute)
    if (candidate <= now) dayEpoch = base + DAY
  }

  if (Number.isNaN(dayEpoch)) return null

  // 日期有、时间没有：默认上午 9 点
  if (!explicitTime) {
    hour = /晚|夜/.test(raw) ? 20 : 9
    minute = 0
  }

  let dueAt = at(dayEpoch, hour, minute)
  // 只说了「今天」而 9 点已过：顺延 1 小时后提醒，而不是立刻算逾期
  if (!explicitTime && dueAt <= now) dueAt = now + HOUR
  return { dueAt, hour, minute, explicitTime }
}

/** 格式化成人类可读的一行，工具结果里用。 */
export function formatDue(dueAt, now = Date.now()) {
  if (typeof dueAt !== 'number' || !Number.isFinite(dueAt)) return ''
  const d = new Date(dueAt)
  const start = dayStart(now)
  const target = dayStart(dueAt)
  const diffDays = Math.round((target - start) / DAY)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const hm = `${hh}:${mm}`
  if (diffDays === 0) return `今天 ${hm}`
  if (diffDays === 1) return `明天 ${hm}`
  if (diffDays === 2) return `后天 ${hm}`
  if (diffDays === -1) return `昨天 ${hm}`
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
  if (diffDays > 0 && diffDays < 7) return `${week} ${hm}`
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
}
