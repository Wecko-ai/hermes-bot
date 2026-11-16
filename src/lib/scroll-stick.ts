/** Distance to the bottom that still counts as the bottom edge. */
export const STICK_EDGE_PX = 80

/**
 * Next pin for the transcript.
 * `deltaY` is the user's movement: negative leaves the latest lines, positive moves toward them,
 * zero is layout or a programmatic scroll. Being near the bottom does not pin the thread again
 * after the user has moved away. The jump-to-bottom control pins on its own, outside this function.
 */
export function nextStick(stick: boolean, deltaY: number, distanceToBottom: number): boolean {
  if (deltaY < 0) return false
  if (deltaY > 0 && distanceToBottom <= STICK_EDGE_PX) return true
  if (distanceToBottom > STICK_EDGE_PX && !stick) return false
  return stick
}
