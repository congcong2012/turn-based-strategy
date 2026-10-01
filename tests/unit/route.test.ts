import { describe, expect, it } from 'vitest'
import { parseRoute } from '../../src/app/route'

describe('路由解析（主页 / 大厅 / 规则）', () => {
  it('默认进主页', () => {
    expect(parseRoute('', '')).toEqual({ page: 'home', roomCode: null, roomKey: null })
    expect(parseRoute('?', '#/', ).page).toBe('home')
  })

  it('邀请链接（?room=）永远直达大厅，老链接不能失效', () => {
    const route = parseRoute('?room=ab23cd', '')
    expect(route.page).toBe('lobby')
    expect(route.roomCode).toBe('AB23CD')
  })

  it('邀请链接带房间密码（?key=）时一并解析', () => {
    const route = parseRoute('?room=AB23CD&key=tea-2024', '')
    expect(route.page).toBe('lobby')
    expect(route.roomKey).toBe('tea-2024')
  })

  it('?key= 会被裁剪到 64 字符以内，空白视为没有', () => {
    expect(parseRoute('?room=AB23CD&key=' + 'x'.repeat(200), '').roomKey?.length).toBe(64)
    expect(parseRoute('?room=AB23CD&key=%20%20', '').roomKey).toBeNull()
  })

  it('规则速查：hash 与 query 两种写法都支持', () => {
    expect(parseRoute('', '#/rules').page).toBe('rules')
    expect(parseRoute('?page=rules', '').page).toBe('rules')
  })

  it('大厅：hash 与 query 两种写法都支持', () => {
    expect(parseRoute('', '#/lobby').page).toBe('lobby')
    expect(parseRoute('?page=lobby', '').page).toBe('lobby')
  })

  it('单人练习（PVE）：hash 与 query 两种写法都支持', () => {
    expect(parseRoute('', '#/pve').page).toBe('pve')
    expect(parseRoute('?page=pve', '').page).toBe('pve')
    // hash 优先，且不影响邀请信息解析
    const invited = parseRoute('?room=AB23CD&page=pve', '#/home')
    expect(invited.page).toBe('home')
    expect(invited.roomCode).toBe('AB23CD')
  })

  it('hash 优先于 query：从 ?page=lobby 进大厅后点"返回主页"必须真的回主页', () => {
    expect(parseRoute('?page=lobby', '#/home').page).toBe('home')
    expect(parseRoute('?page=rules', '#/lobby').page).toBe('lobby')
    // 邀请链接同理：点过导航之后以 hash 为准（房间信息仍然解析出来备用）
    const invited = parseRoute('?room=AB23CD&key=tea&page=lobby', '#/home')
    expect(invited.page).toBe('home')
    expect(invited.roomCode).toBe('AB23CD')
    expect(invited.roomKey).toBe('tea')
    // 没有 hash 时，邀请链接照旧直达大厅
    expect(parseRoute('?room=AB23CD', '').page).toBe('lobby')
  })

  it('无法识别的 hash 不生效（回退到 query / 主页）', () => {
    expect(parseRoute('', '#/nope').page).toBe('home')
    expect(parseRoute('?page=lobby', '#/nope').page).toBe('lobby')
  })

  it('非法房间码不算邀请链接（回主页，不误进大厅）', () => {
    expect(parseRoute('?room=ab1', '').page).toBe('home')
    expect(parseRoute('?room=', '').page).toBe('home')
  })
})
