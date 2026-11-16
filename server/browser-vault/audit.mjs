import fs from 'node:fs'

/** Rotate the audit log once it is larger than this. One previous file (`.1`) is kept. */
export const AUDIT_MAX_BYTES = 2 * 1024 * 1024

/**
 * Append one JSON line. When the file is already over {@link AUDIT_MAX_BYTES}, rename it to
 * `<file>.1` first (replacing the previous backup) so the log cannot grow without bound.
 * The line is the vault's fixed audit object: no password.
 */
export function appendAudit(file, line) {
  try {
    if (fs.statSync(file).size > AUDIT_MAX_BYTES) fs.renameSync(file, `${file}.1`)
  } catch {
    // No file yet, or the rename failed: still append. The log must not block the vault.
  }
  fs.appendFileSync(file, `${line}\n`, { mode: 0o600 })
}
