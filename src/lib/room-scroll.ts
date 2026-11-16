/** Distance from the bottom that still counts as sitting on the latest line. */
export const ROOM_STICK_EDGE_PX = 80

/**
 * Whether a room transcript stays pinned to the latest line.
 *
 * `deltaY` uses the wheel sign: negative moves toward older lines (wheel up, scrollbar
 * drag up, Page Up), positive moves toward the latest line. Zero is a layout change
 * (a new event, an image) and must not detach a reader who was following, nor reattach
 * one who scrolled away. A position inside the edge, such as 40px, stays unstuck after
 * an upward move. Stick returns only when the reader moves downward onto that edge.
 */
export function nextStick(stuck: boolean, deltaY: number, distanceToBottom: number) {
  if (deltaY < 0) return false
  if (deltaY > 0) return distanceToBottom <= ROOM_STICK_EDGE_PX
  return stuck
}

/** A send that resolves after the reader left the room must not clear the room now on screen. */
export function roomSendSettled(startedRoomId: string, shownRoomId: string, sent: boolean) {
  return { clearStorage: sent, clearField: sent && startedRoomId === shownRoomId }
}

/** Stop's busy flag belongs to the room that was stopped, not the room opened while it was in flight. */
export function roomStopStillCurrent(startedRoomId: string, shownRoomId: string) {
  return startedRoomId === shownRoomId
}
