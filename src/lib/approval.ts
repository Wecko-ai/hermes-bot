/** A card may record “sent” only when the send was not refused. `false` keeps the form and the draft. */
export async function approvalAccepted(result: Promise<boolean | void> | boolean | void): Promise<boolean> {
  return (await result) !== false
}
