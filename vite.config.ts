import { readFileSync } from 'node:fs'
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

// 构建期注入版本信息（CI 里 GITHUB_SHA 由 runner 自动提供）
const pkgVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version as string
const gitSha = process.env.GITHUB_SHA ?? process.env.VITE_GIT_SHA ?? 'local'

const base = resolveBase()

export default defineConfig({
  base,
  define: {
    __APP_VERSION__: JSON.stringify(pkgVersion),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __GIT_SHA__: JSON.stringify(gitSha),
  },
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: true, target: 'es2022' },
  // 固定绑定 127.0.0.1：Windows 上 localhost 会解析到 ::1，导致 Playwright 的探活失败
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    // 套件里有"整局 AI 自对弈"级别的模拟（pveSession / ai 的完整对局用例），
    // 单跑约 2–3 秒，在 CI 或全量并行时会超过默认的 5 秒。给一个仍然能抓住"卡死"的上限。
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: 'coverage',
      // 只统计真正的产品代码。`src/main.tsx` 是纯挂载入口、`src/render/**` 是 Pixi 画布
      // （渲染结果靠 E2E 断言，单测跑不动 WebGL）—— 把它们算进来只会稀释信号。
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/main.tsx',
        'src/vite-env.d.ts',
        'src/render/**',
        'src/ui/**',
        'src/hooks/**',
        '**/*.d.ts',
      ],
      // ★ 不设 thresholds：本项目的防线是"404 条单测 + 59 条 E2E"，
      //   覆盖率是用来看**盲区**的体检表，不是用来卡 CI 的门槛
      //   （设了门槛只会逼着人写凑数的断言，反而降低质量）。
    },
  },
})