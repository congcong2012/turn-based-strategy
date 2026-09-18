/**
 * 本地验证 GitHub Pages 子路径部署（用于复现"线上白屏"这类问题）：
 *   pnpm build && node scripts/serve-subpath.mjs turn-based-strategy 4180
 * 再访问 http://127.0.0.1:4180/turn-based-strategy/
 *
 * 注意：参数请传**仓库名**而不是 "/repo/"。
 *   Git Bash(MSYS) 会把命令行里形如 /xxx/ 的参数当成 POSIX 路径，
 *   自动转换成 "C:/Program Files/Git/xxx/"，导致前缀匹配失败（404）。
 *   脚本内部做了容错：即使拿到被转换过的值，也只取最后一段作为仓库名。
 */
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

function toRepoName(raw) {
  const value = (raw ?? 'turn-based-strategy').trim()
  // 兼容被 MSYS 转换过的值：C:/Program Files/Git/turn-based-strategy/ -> turn-based-strategy
  const parts = value.split(/[\\/]+/).filter(Boolean)
  const last = parts[parts.length - 1] ?? 'turn-based-strategy'
  return last.replace(/[^\w.-]/g, '') || 'turn-based-strategy'
}

const repo = toRepoName(process.argv[2])
const prefix = '/' + repo + '/'
const port = Number(process.argv[3] ?? 4180)
const distDir = fileURLToPath(new URL('../dist/', import.meta.url))
const rootDir = distDir.endsWith(sep) ? distDir : distDir + sep

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (!url.pathname.startsWith(prefix)) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found (expected prefix ' + prefix + ')')
    return
  }
  let rel = decodeURIComponent(url.pathname.slice(prefix.length))
  if (rel === '' || rel.endsWith('/')) rel += 'index.html'
  const safeRel = normalize(rel).replace(/^([.][.][/\\])+/, '')
  const filePath = join(distDir, safeRel)
  if (!filePath.startsWith(rootDir)) {
    res.writeHead(403).end()
    return
  }
  try {
    await stat(filePath)
    const body = await readFile(filePath)
    res.writeHead(200, { 'content-type': types[extname(filePath)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('404 ' + rel)
  }
}).listen(port, '127.0.0.1', () => {
  console.log('serving ' + distDir + ' at http://127.0.0.1:' + port + prefix)
})
