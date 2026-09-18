import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'

export const ROOM = 'AB23CD'
export const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function randomRoom(): string {
  let out = ''
  for (let i = 0; i < 6; i += 1) {
    out += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)]
  }
  return out
}

/** DEV 专用入口：?transport=local 走同机 BroadcastChannel，?as= 指定身份 */
export function localUrl(playerId: string, nickname: string): string {
  return '/?transport=local&as=' + playerId + '&nick=' + encodeURIComponent(nickname)
}

export async function joinRoom(page: Page, roomCode: string, nickname: string): Promise<void> {
  await page.getByTestId('nickname-input').fill(nickname)
  await page.getByTestId('room-code-input').fill(roomCode)
  await expect(page.getByTestId('join-button')).toBeEnabled()
  await page.getByTestId('join-button').click()
  await expect(page.getByTestId('room-code-display')).toHaveText(roomCode)
}

export async function waitForHost(page: Page, timeout = 20_000): Promise<void> {
  await expect(page.getByTestId('role-label')).toHaveText('你是房主', { timeout })
}
