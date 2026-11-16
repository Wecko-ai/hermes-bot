/** A room row animates a member only while that member is in the driver's activity. Everyone else stays idle. */
export function roomRowAvatarStatus(memberId: string, activity: readonly { member_id: string }[] | undefined): 'working' | 'idle' {
  return activity?.some((item) => item.member_id === memberId) ? 'working' : 'idle'
}
