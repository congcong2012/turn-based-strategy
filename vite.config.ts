import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// GitHub Pages 子路径部署：
//   默认 base = './'（相对路径）。产物资源写成 ./assets/xxx.js，
//   无论仓库叫什么，挂在 https://<user>.github.io/<repo>/ 下都能正确加载，零配置。
//   如需绝对子路径可用 VITE_BASE=/<repo>/ 覆盖（必须形如 "/xxx/"）。
//   注意：Git Bash(MSYS) 会把 "/xxx/" 这类值当 POSIX 路径转换成 "C:/Program Files/Git/xxx/"，
//   所以这里做一次校验，非法值直接忽略并回退到相对路径 —— 宁可相对，也不要白屏。
function resolveBase(): string {
  const raw = process.env.VITE_BASE?.trim()
  if (!raw) return './'
  if (!/^\/[\w.-]+\/$/.test(raw)) {
    console.warn('[vite] 忽略非法 VITE_BASE=' + raw + '（应为 /repo-name/ 形式），回退到相对路径 ./')
    return './'
  }
  return raw
}

const base = resolveBase()

export default defineConfig({
  base,
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: true, target: 'es2022' },
  // 固定绑定 127.0.0.1：Windows 上 localhost 会解析到 ::1，导致 Playwright 的探活失败
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
  },
})
