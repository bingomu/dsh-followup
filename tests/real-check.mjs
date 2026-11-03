/**
 * 真实 GUI 冒烟：用 App 当前端口的鉴权 cookie，在无头 Chrome 里打开
 * http://127.0.0.1:<port>/，确认 dsh-followup 的客户端入口真的挂上了。
 *
 *   node tests/real-check.mjs 55846
 *
 * 只读：不动会话、不发消息，只截图和读 DOM。
 */

import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = Number(process.argv[2] ?? 0)
if (!PORT) throw new Error('usage: node tests/real-check.mjs <app-port>')
const CDP = 9334
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const COOKIE_DB = join(process.env.HOME, 'Library/Application Support/@deepseek-ai/dsh-desktop/Cookies')

/** 从 Chromium cookie 库里找当前端口的 dsh-auth cookie。 */
function currentCookie(port) {
  const output = execFileSync('sqlite3', [COOKIE_DB, 'select name, value from cookies'], { encoding: 'utf8' })
  for (const line of output.split('\n')) {
    const index = line.indexOf('|')
    if (index < 0) continue
    const name = line.slice(0, index)
    const value = line.slice(index + 1)
    if (!value.startsWith('v1.')) continue
    const parts = value.split('.')
    try {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
      if (String(payload.authority ?? '').endsWith(`:${port}`)) return { name, value }
    } catch {
      /* 不是我们的 cookie */
    }
  }
  throw new Error(`没有找到 127.0.0.1:${port} 的 dsh-auth cookie —— App 页面可能还没加载`)
}

/** 起一个只给本次检查用的无头 Chrome。 */
function startChrome() {
  const profile = mkdtempSync(join(tmpdir(), 'fu-real-chrome-'))
  const child = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--disable-crash-reporter', '--disable-breakpad', '--hide-scrollbars',
    '--force-device-scale-factor=2', `--remote-debugging-port=${CDP}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--window-size=1440,900', 'about:blank',
  ], { detached: true, stdio: 'ignore' })
  child.unref()
  return { pid: child.pid, profile }
}

/** 等 CDP 起来。 */
async function waitCdp() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP}/json/version`)
      if (res.ok) return
    } catch {
      /* 还没起 */
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  throw new Error('chrome CDP 没起来')
}

/** 极简 CDP 客户端。 */
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  const events = []
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(JSON.stringify(message.error)))
      else resolve(message.result)
    } else if (message.method) {
      events.push(message)
    }
  })
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', reject)
  })
  return {
    events,
    ready,
    close: () => ws.close(),
    send(method, params = {}) {
      const mid = ++id
      ws.send(JSON.stringify({ id: mid, method, params }))
      return new Promise((resolve, reject) => pending.set(mid, { resolve, reject }))
    },
  }
}

async function main() {
  const cookie = currentCookie(PORT)
  const chrome = startChrome()
  await waitCdp()
  const target = await (await fetch(`http://127.0.0.1:${CDP}/json/new?about:blank`, { method: 'PUT' })).json()
  const c = connect(target.webSocketDebuggerUrl)
  await c.ready
  await c.send('Page.enable')
  await c.send('Runtime.enable')
  await c.send('Log.enable')
  await c.send('Network.enable')
  await c.send('Network.setCookie', {
    name: cookie.name,
    value: cookie.value,
    domain: '127.0.0.1',
    path: '/',
    httpOnly: false,
    secure: false,
  })
  await c.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
  await new Promise((resolve) => setTimeout(resolve, 7000))

  const probe = await c.send('Runtime.evaluate', {
    expression: `(() => {
      const entry = document.querySelector('.fu-entry')
      const boot = globalThis.__DSH_BOOT__?.entries?.some(e => e.id === 'dsh-followup') ?? null
      return {
        title: document.title,
        bootHasFollowup: boot,
        entryFound: entry !== null,
        entryText: entry ? entry.textContent : null,
        headerFound: document.querySelector('.fu-hbadge') !== null,
        headerText: document.querySelector('.fu-hbadge')?.textContent ?? null,
        entryRect: entry ? entry.getBoundingClientRect().toJSON() : null,
        entryStyle: entry ? (() => { const cs = getComputedStyle(entry); return { width: cs.width, flex: cs.flex, display: cs.display, padding: cs.padding } })() : null,
        chain: entry ? (() => { const out = []; let node = entry; for (let i = 0; i < 5 && node; i++) { out.push({ tag: node.tagName, cls: typeof node.className === 'string' ? node.className.slice(0, 120) : '', w: Math.round(node.getBoundingClientRect().width) }); node = node.parentElement } return out })() : null,
        bodyText: (document.body.innerText || '').slice(0, 300),
      }
    })()`,
    returnByValue: true,
    awaitPromise: true,
  })
  const value = probe.result?.value
  console.log(JSON.stringify(value, null, 2))

  const headerInfo = value?.headerFound === true
    ? await (async () => {
        await c.send('Runtime.evaluate', { expression: `document.querySelector('.fu-hbadge').click()`, returnByValue: true })
        await new Promise((resolve) => setTimeout(resolve, 800))
        const pop = await c.send('Runtime.evaluate', {
          expression: `(() => {
            const el = document.querySelector('.fu-pop')
            return {
              open: el !== null,
              text: el ? el.innerText.slice(0, 400) : null,
              picks: document.querySelectorAll('.fu-pick').length,
            }
          })()`,
          returnByValue: true,
        })
        return pop.result?.value
      })()
    : null
  console.log('header:', JSON.stringify(headerInfo))

  const noSheet = process.env.NO_SHEET === '1'
  if (noSheet) {
    const toast = await c.send('Runtime.evaluate', {
      expression: `(() => { const t = document.querySelector('.fu-toast'); return t ? { found: true, text: t.textContent, rect: t.getBoundingClientRect().toJSON() } : { found: false } })()`,
      returnByValue: true,
    })
    console.log('toast:', JSON.stringify(toast.result?.value))
  }
  if (value?.entryFound && !noSheet) {
    // 点开面板，等动画结束再截图
    await c.send('Runtime.evaluate', { expression: `document.querySelector('.fu-entry').click()`, returnByValue: true })
    await new Promise((resolve) => setTimeout(resolve, 900))
    const sheet = await c.send('Runtime.evaluate', {
      expression: `(() => {
        const sheet = document.querySelector('.fu-sheet')
        return {
          open: document.querySelector('.fu-root')?.dataset.open ?? null,
          rows: document.querySelectorAll('.fu-row').length,
          sub: document.querySelector('.fu-sub')?.textContent ?? null,
          tabs: [...document.querySelectorAll('.fu-tab')].map((el) => el.textContent),
          sessions: document.querySelectorAll('.fu-srow').length,
        }
      })()`,
      returnByValue: true,
    })
    console.log('sheet:', JSON.stringify(sheet.result?.value))
  }

  const shot = await c.send('Page.captureScreenshot', { format: 'png' })
  const out = join(process.cwd(), 'tests/shots/real-app.png')
  writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log('screenshot:', out)

  const errors = c.events
    .filter((event) => event.method === 'Log.entryAdded' && event.params.entry.level === 'error')
    .map((event) => event.params.entry.text)
    .filter((text) => /followup|dsh-followup/i.test(text))
  console.log('plugin errors:', errors.length > 0 ? errors : 'none')

  c.close()
  try { process.kill(chrome.pid) } catch { /* 已退出 */ }
}

await main()
