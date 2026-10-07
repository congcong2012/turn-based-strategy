/**
 * 一条命令跑完全部 5 条 E2E 轨道（**本地发版清单用**，CI 不跑这个）。
 *
 *   npm run e2e:all                 # 跑 local / mobile / preview / p2p / manual
 *   npm run e2e:all -- --tracks=local,preview
 *   npm run e2e:all -- --timeout=600   # 每轨超时（秒），默认 420
 *
 * 它替你把这几件"每次发版都要手工做、还容易做错"的事兜住：
 *
 *  1. **自己把 5173 与 4173 起起来**。`playwright.config.ts` 的 webServer 是**顶层数组**，
 *     所以连 `--project=local` 也要求 4173 就绪；而本机代理会挡住 Playwright 自起的探测
 *     （表现为挂死不报错）。起服务时带上 `CODEBUDDY_SAFE_DELETE_ENABLED=0`
 *     —— dev 服务器要清 `node_modules/.vite/deps`，不带就会被安全删除保护拦下。
 *
 *  2. ★ **每轨套超时**。本机实测：每条轨道**用例全绿之后进程并不退出**（会一直挂着），
 *     所以"等它自己结束"是等不到的。超时不等于失败 —— 判定看的是**日志内容**。
 *
 *  3. ★ **判定只看 `^  ok` 的条数，不看退出码、也不看日志尾行**。
 *     超时杀进程会把尾行写花（`===== x =====` 会缺字符、`N passed` 可能被吃掉），
 *     拿那两行判断会把"正常跑完"误判成失败。
 *
 *  4. 收尾把两个服务一起杀掉；日志按轨落在 `tmp/e2e-all/`。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const TRACKS = ['local', 'mobile', 'preview', 'p2p', 'manual']
/** 各轨的期望条数：只用来提示"是不是少跑了"，不作为硬门槛（改了用例数不用同步改这里） */
const EXPECTED = { local: 48, mobile: 2, preview: 4, p2p: 1, manual: 1 }

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const tracks = opt('tracks', TRACKS.join(','))
  .split(',')
  .map((t) => t.trim())
  .filter((t) => t.length > 0)
for (const t of tracks) {
  if (!TRACKS.includes(t)) {
    console.error(`未知轨道：${t}（可用：${TRACKS.join(' / ')}）`)
    process.exit(2)
  }
}
const timeoutMs = Number(opt('timeout', '420')) * 1000

const isWin = process.platform === 'win32'
const childEnv = { ...process.env, CODEBUDDY_SAFE_DELETE_ENABLED: '0', CI: '' }

/** 起一个常驻进程（dev / preview 服务器） */
function startServer(cmd, args2) {
  return spawn(cmd, args2, { env: childEnv, shell: true, stdio: 'ignore', detached: !isWin })
}

/** 连整棵进程树一起杀（Windows 上 non-shell 子进程会挂着不放） */
function killTree(child) {
  if (!child || child.killed || child.exitCode !== null) return
  try {
    if (isWin) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(-child.pid, 'SIGKILL')
  } catch {
    /* 已经退出了就算了 */
  }
}

/** 已经有服务在跑（比如你手工起着 dev）就别重复起，直接复用 —— Playwright 那边也是复用 */
async function isUp(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

async function waitForServer(url, label, timeout = 90_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (res.ok) return true
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`${label} 在 ${timeout / 1000}s 内没起来（${url}）`)
}

/** 跑一轨，返回 { code, timedOut, log } */
function runTrack(track, logFile) {
  return new Promise((resolve) => {
    const out = []
    const child = spawn('npx', ['playwright', 'test', `--project=${track}`], {
      env: childEnv,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !isWin,
    })
    const collect = (buf) => out.push(buf.toString())
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child) // 本机"跑完不退出"，超时是常态；判定看日志
    }, timeoutMs)

    child.on('close', (code) => {
      clearTimeout(timer)
      const log = out.join('')
      writeFileSync(logFile, log, 'utf8')
      resolve({ code, timedOut, log })
    })
  })
}

/**
 * 判定：失败数必须为 0，且至少有一条 ok（超时杀进程不影响结论）。
 *
 * ⚠️ 正则要写成 `ok\s+\d+` 而不是 `ok \d+` —— Playwright 的 list reporter 会把序号
 * **补空格对齐**（`  ok  1` 而 `  ok 10`），只认一个空格会漏掉前 9 条
 * （2026-10-07 实测：51 条只数出 42 条）。
 */
function verdictOf(log) {
  const ok = (log.match(/^\s+ok\s+\d+/gm) ?? []).length
  const failed = (log.match(/^\s+(?:✘|x|×)\s+\d+/gm) ?? []).length
  return { ok, failed, pass: failed === 0 && ok > 0 }
}

const outDir = join('tmp', 'e2e-all')
mkdirSync(outDir, { recursive: true })

console.log('准备 5173（dev）与 4173（preview）……')
const dev = (await isUp('http://127.0.0.1:5173/'))
  ? null
  : startServer('npx', ['vite', '--port', '5173', '--strictPort'])
const pre = (await isUp('http://127.0.0.1:4173/'))
  ? null
  : startServer('npx', ['vite', 'preview', '--port', '4173', '--strictPort'])
if (dev || pre) console.log('（自己起了服务；已经有在跑的那几个直接复用）')

let exitCode = 0
const summary = []

try {
  await waitForServer('http://127.0.0.1:5173/', 'dev 服务器')
  await waitForServer('http://127.0.0.1:4173/', 'preview 服务器')
  console.log('两个服务就绪。\n')

  for (const track of tracks) {
    const logFile = join(outDir, track + '.log')
    process.stdout.write(`▶ ${track} … `)
    const { timedOut, log } = await runTrack(track, logFile)
    const { ok, failed, pass } = verdictOf(log)
    const expect = EXPECTED[track]
    const hint = expect && ok !== expect ? `（预期 ${expect} 条，实得 ${ok}）` : ''
    if (pass) {
      console.log(`✅ ${ok} 通过${timedOut ? '（超时收尾，属正常）' : ''}${hint}`)
    } else {
      console.log(`❌ 通过 ${ok} · 失败 ${failed} → 见 ${logFile}`)
      exitCode = 1
    }
    summary.push({ track, ok, failed, pass, logFile })
    // 失败即停：后面几轨没有意义，先修再跑
    if (!pass) break
  }
} catch (err) {
  console.error('\n' + String(err?.message ?? err))
  exitCode = 1
} finally {
  killTree(dev)
  killTree(pre)
}

console.log('\n===== 汇总 =====')
for (const row of summary) {
  console.log(`${row.pass ? '✅' : '❌'} ${row.track.padEnd(8)} 通过 ${row.ok} · 失败 ${row.failed}`)
}
const ran = summary.length
const total = summary.reduce((n, r) => n + r.ok, 0)
console.log(`共跑了 ${ran}/${tracks.length} 轨，合计通过 ${total} 条。日志：${outDir}/`)
if (exitCode === 0 && ran < tracks.length) console.log('（有轨道未跑：被 --tracks 限定，或前一轨失败后提前停止）')

process.exit(exitCode)
