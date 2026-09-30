import { describe, expect, it } from 'vitest'
import { APP_VERSION, versionLine } from '../../src/version'

describe('版本信息', () => {
  it('版本号由构建期注入，形如 1.0.0（与 package.json 同源）', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('versionLine 一定带 v 前缀（发版排查时的第一手信息）', () => {
    expect(versionLine().startsWith('v' + APP_VERSION)).toBe(true)
  })
})
