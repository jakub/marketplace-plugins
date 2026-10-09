// Makes the acceptance document's two media files from the shipped runtime: packs the shipped example plan into work/,
// serves it as serve.mjs does, takes a real screenshot of it with one claim open (example-shot.png), and turns four frames
// of the same page (closed, a claim open, a decision changed, the Respond sheet) into a 4 s VP9 clip (runtime-clip.webm).
// Run: node make-media.mjs   (writes beside itself; needs /usr/bin/chromium and ffmpeg)
import { createRequire } from 'node:module'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from './serve.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const WT = join(HERE, '..', '..')
const WORK = join(HERE, 'work', 'example'); mkdirSync(WORK, { recursive: true })
copyFileSync(join(WT, 'plugins/plans/skills/doc/examples/scheduled-send.html'), join(WORK, 'scheduled-send.html'))
const p = spawnSync(process.execPath, [join(WT, 'plugins/plans/skills/doc/runtime/pack.mjs'), '--quiet', join(WORK, 'scheduled-send.html')], { encoding: 'utf8' })
if (p.status !== 0) { console.error(p.stdout + p.stderr); process.exit(2) }

const { chromium } = createRequire('/home/jakub/.npm/_npx/e41f203b7505f1fb/node_modules/')('playwright')
const { server, url } = await serve(join(WORK, 'scheduled-send.packed.html'))
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', ignoreDefaultArgs: ['--disable-ipc-flooding-protection'] })
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, colorScheme: 'light' })
  const page = await ctx.newPage()
  await page.goto(url); await page.waitForFunction(() => document.documentElement.dataset.nwReady === '1')
  const frames = join(WORK, 'frames'); rmSync(frames, { recursive: true, force: true }); mkdirSync(frames)
  await page.screenshot({ path: join(frames, 'f1.png') })
  await page.locator('doc-plan > doc-claim > .pl-row').first().click(); await page.waitForTimeout(400)
  await page.screenshot({ path: join(frames, 'f2.png') })
  await page.screenshot({ path: join(HERE, 'example-shot.png') })
  await page.evaluate(() => { const a = document.getElementById('limit'); a.closest('doc-plan')._reveal(a); a.scrollIntoView({ block: 'center' }) })
  await page.locator('#limit input[value="500"]').check(); await page.waitForTimeout(400)
  await page.screenshot({ path: join(frames, 'f3.png') })
  await page.locator('.nw-respond').click(); await page.locator('.nw-sheet textarea.nw-out').waitFor(); await page.waitForTimeout(300)
  await page.screenshot({ path: join(frames, 'f4.png') })
  await ctx.close()
  const f = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '1', '-i', join(frames, 'f%d.png'), '-vf', 'scale=960:-2,fps=25,format=yuv420p',
    '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '36', '-an', join(HERE, 'runtime-clip.webm')], { encoding: 'utf8' })
  if (f.status !== 0) { console.error(f.stderr); process.exit(1) }
  console.log('wrote example-shot.png and runtime-clip.webm')
} finally { await browser.close(); server.close() }
