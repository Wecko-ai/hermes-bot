// Regenerates the README screenshots (docs/readme/ui-*.png and docs/screenshot.png) from the
// current build, in demo mode: no Hermes gateway, fictional data, nothing leaves 127.0.0.1.
// Usage: npm run build && npm run screenshots
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'docs', 'readme')
const PORT = 4362
const VAULT_PORT = 4363
const UNUSED_PORT = 4364 // nothing listens here: Hermes and Ollama stay unreachable on purpose
const BASE = `http://127.0.0.1:${PORT}`

if (!existsSync(path.join(ROOT, 'dist', 'index.html'))) {
  console.error('dist/ is missing. Run `npm run build` first.')
  process.exit(1)
}

const written = []
const skipped = []
const sandbox = mkdtempSync(path.join(os.tmpdir(), 'hb-shots-'))
const configFile = path.join(sandbox, 'config.json')
writeFileSync(configFile, JSON.stringify({ ui: { defaultBot: 'nova' } }))
mkdirSync(path.join(sandbox, 'animations'))

let server
let browser
try {
  let serverLog = ''
  server = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: sandbox, // the server never touches the real settings
      NODE_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: String(PORT),
      BROWSER_VAULT_PORT: String(VAULT_PORT),
      HERMES_ORIGIN: `http://127.0.0.1:${UNUSED_PORT}`,
      OLLAMA_ORIGIN: `http://127.0.0.1:${UNUSED_PORT}`,
      HERMESBOT_NO_PRIVATE: '1',
      HERMESBOT_CONFIG: configFile,
      HERMESBOT_ANIMATIONS: path.join(sandbox, 'animations'),
      HERMESBOT_VAULT_TOKEN_FILE: path.join(sandbox, 'vault.token'),
      HERMES_HOME: path.join(sandbox, 'hermes'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stdout.on('data', (d) => { serverLog += d })
  server.stderr.on('data', (d) => { serverLog += d })
  let ready = false
  for (let i = 0; i < 100 && !ready; i += 1) {
    try { ready = (await fetch(`${BASE}/api/health`)).ok } catch { /* not ready */ }
    if (!ready) await delay(100)
  }
  if (!ready) throw new Error(`Server did not start:\n${serverLog.slice(-600)}`)

  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'en-US', deviceScaleFactor: 2 })
  // No animation pack, as on a fresh install.
  await page.route('**/api/app-config', async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, json: { ...(await response.json()), animatedBots: [] } })
  })
  await page.goto(`${BASE}/?demo=1`, { waitUntil: 'domcontentloaded' })
  await page.locator('.working-strip.has-work').waitFor({ timeout: 15_000 })
  await page.locator('.section-heading', { hasText: 'Build' }).first().waitFor({ timeout: 5_000 })
  await page.locator('[data-bot=orion] .bot-row-status.is-working').waitFor({ timeout: 10_000 })
  await page.getByRole('button', { name: /details/i }).first().click()
  await page.getByText('Morning briefing').waitFor({ timeout: 5_000 })
  await page.getByText('Give me a quick update.').waitFor({ timeout: 5_000 })

  const setTheme = async (name) => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.getByRole('radio', { name }).click()
    await dialog.press('Escape')
    await dialog.waitFor({ state: 'detached', timeout: 3_000 })
    await page.waitForFunction((t) => document.documentElement.dataset.theme === t, name.toLowerCase())
  }
  const settle = (ms = 700) => delay(ms)
  const save = async (name, theme) => {
    const file = path.join(OUT, `${name}-${theme}.png`)
    await page.screenshot({ path: file })
    written.push(file)
  }
  const openBot = async (slug) => {
    await page.locator(`[data-bot="${slug}"]`).click()
    await page.locator(`[data-bot="${slug}"].is-selected`).waitFor({ timeout: 3_000 })
  }
  const resetUi = async () => {
    for (let i = 0; i < 3; i += 1) await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Groups', exact: true }).click()
    await page.locator('.section-heading').first().waitFor({ timeout: 3_000 })
    await page.locator('[data-bot=nova]').click()
    await page.locator('[data-bot=nova].is-selected').waitFor({ timeout: 3_000 })
    await settle(300)
  }

  const views = [
    ['ui-overview', async () => {
      await page.getByRole('tab', { name: 'Routines' }).click()
      await page.getByText('Morning briefing').waitFor({ timeout: 3_000 })
      await settle(900)
    }],
    ['ui-activity', async () => {
      await page.getByRole('button', { name: 'Activity', exact: true }).click()
      await page.locator('.section-heading').first().waitFor({ state: 'detached', timeout: 3_000 })
      await settle()
    }],
    ['ui-palette', async () => {
      await page.keyboard.press('Meta+k')
      const box = page.getByRole('textbox', { name: 'Search for a bot' })
      await box.waitFor({ timeout: 3_000 })
      await page.locator('.palette-results').getByText('Nova', { exact: true }).waitFor({ timeout: 3_000 })
      await settle()
    }],
    ['ui-bot-menu', async () => {
      await page.locator('[data-bot=orion]').click({ button: 'right' })
      await page.locator('.bot-menu:not(.is-sub)').waitFor({ timeout: 3_000 })
      await settle()
    }],
    ['ui-settings', async () => {
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Settings' })
      await dialog.waitFor({ timeout: 3_000 })
      await dialog.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'General' }).click()
      await settle()
    }],
    ['ui-mail', async () => {
      await openBot('sage')
      await page.locator('.mail-card').waitFor({ timeout: 3_000 })
      await page.locator('.mail-card .mail-subject').waitFor({ timeout: 3_000 })
      await settle()
    }],
    ['ui-questions', async () => {
      await openBot('lyra')
      await page.locator('.questions-card').waitFor({ timeout: 3_000 })
      await page.locator('.questions-card .questions-answer').nth(1).waitFor({ timeout: 3_000 })
      await settle()
    }],
    ['ui-queue', async () => {
      await openBot('orion')
      await page.locator('.message-delivery.is-queue').waitFor({ timeout: 3_000 })
      await page.locator('.message-delivery.is-priority').waitFor({ timeout: 3_000 })
      await page.locator('.working-row').waitFor({ timeout: 3_000 })
      await settle(900)
    }],
    ['ui-local', async () => {
      await openBot('local:ollama')
      const chat = page.locator('main.local-chat:not([hidden])')
      await chat.waitFor({ timeout: 3_000 })
      await chat.locator('.message-assistant').nth(1).waitFor({ timeout: 3_000 })
      await settle()
    }],
  ]

  mkdirSync(OUT, { recursive: true })
  for (const theme of ['light', 'dark']) {
    await setTheme(theme === 'light' ? 'Light' : 'Dark')
    for (const [name, prepare] of views) {
      try {
        await resetUi()
        await prepare()
        await save(name, theme)
      } catch (error) {
        const reason = String(error.message || error).split('\n')[0]
        if (!skipped.some((s) => s.startsWith(`${name}:`))) skipped.push(`${name}: ${reason}`)
        console.error(`skipped ${name} (${theme}): ${reason}`)
      }
    }
  }
  await setTheme('Light')
  const overview = path.join(OUT, 'ui-overview-light.png')
  if (existsSync(overview)) {
    const target = path.join(ROOT, 'docs', 'screenshot.png')
    copyFileSync(overview, target)
    written.push(target)
  }
} finally {
  await browser?.close().catch(() => undefined)
  if (server && server.exitCode === null) {
    const stopped = new Promise((resolve) => server.once('exit', resolve))
    server.kill('SIGTERM')
    await Promise.race([stopped, delay(3_000)])
    if (server.exitCode === null) server.kill('SIGKILL')
  }
  rmSync(sandbox, { recursive: true, force: true })
}

for (const file of written) {
  const buf = readFileSync(file)
  console.log(`${path.relative(ROOT, file)}  ${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`)
}
if (skipped.length) {
  console.log(`\nSkipped:\n${skipped.map((s) => `  ${s}`).join('\n')}`)
  process.exitCode = 1
}
