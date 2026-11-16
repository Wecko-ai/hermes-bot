import { describe, expect, it } from 'vitest'
import { roomRowAvatarStatus } from './room-row'

describe('room row avatars', () => {
  const activity = [{ member_id: 'member-a' }, { member_id: 'member-b' }]

  it('animates only members present in the driver activity', () => {
    expect(roomRowAvatarStatus('member-a', activity)).toBe('working')
    expect(roomRowAvatarStatus('member-c', activity)).toBe('idle')
    expect(roomRowAvatarStatus('member-a', [])).toBe('idle')
    expect(roomRowAvatarStatus('member-a', undefined)).toBe('idle')
  })
})
