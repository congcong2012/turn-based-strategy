import { describe, expect, it } from 'vitest'
import { describeErrorCode } from '../../src/game/errorText'

describe('错误码文案', () => {
  it('常见错误都有中文解释', () => {
    expect(describeErrorCode('NOT_YOUR_TURN')).toBe('还没轮到你行动')
    expect(describeErrorCode('OUT_OF_RANGE')).toBe('目标不在射程内')
    expect(describeErrorCode('INSUFFICIENT_FUNDS')).toBe('军费不足')
    expect(describeErrorCode('DEPLOY_ZONE_INVALID')).toContain('部署区')
    expect(describeErrorCode('INDIRECT_MOVED')).toContain('投石车')
  })

  it('未知错误码有兜底文案（不会显示成 undefined）', () => {
    expect(describeErrorCode('SOMETHING_NEW')).toBe('操作被拒绝（SOMETHING_NEW）')
  })
})
