/**
 * 版本信息（由构建时注入，见 vite.config.ts 的 define）
 * 单一版本源：package.json 的 version
 */

declare const __APP_VERSION__: string
declare const __BUILD_TIME__: string
declare const __GIT_SHA__: string

export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'
export const BUILD_TIME: string = typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__ : ''
export const GIT_SHA: string = typeof __GIT_SHA__ === 'string' ? __GIT_SHA__ : 'local'

/** 例如 v1.0.0 · 2026-09-30 · a1b2c3d */
export function versionLine(): string {
  const date = BUILD_TIME ? BUILD_TIME.slice(0, 10) : ''
  return 'v' + APP_VERSION + (date ? ' · ' + date : '') + ' · ' + GIT_SHA.slice(0, 7)
}
