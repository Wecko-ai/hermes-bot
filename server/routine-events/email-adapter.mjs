/**
 * Gmail polling adapter. Production installs need OAuth via Hermes google_workspace;
 * until wired, use the fake adapter in tests and note the gap in REPORT.md.
 */
export function createMissingEmailAdapter() {
  return {
    kind: 'missing',
    async search() {
      return []
    },
  }
}

/** Deterministic adapter for vitest and e2e harness injection. */
export function createFakeEmailAdapter(initial = []) {
  let messages = [...initial]
  return {
    kind: 'fake',
    push(message) {
      messages = [message, ...messages]
    },
    async search(query) {
      const needle = String(query || '').toLowerCase()
      return messages.filter((row) => !needle || `${row.subject} ${row.from} ${row.snippet}`.toLowerCase().includes(needle))
    },
  }
}