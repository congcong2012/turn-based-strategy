import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// GitHub Pages 子路径部署：
//   默认 base = './'（相对路径，任意仓库名都能直接跑，无需配置）
//   Actions 里通过 VITE_BASE=/${{ github.event.repository.name }}/ 注入绝对子路径
const base = process.env.VITE_BASE ?? './'

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
