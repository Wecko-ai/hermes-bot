// safeStorage files for sessions, saved credentials, and local chat.
// A missing file is "nothing stored". A file that exists but cannot be read or decrypted
// throws, so the caller can refuse to overwrite the ciphertext. A failed write throws
// `store_write_failed` and does not keep the original error (it can mention the keychain).

function isMissingFile(error) {
  return Boolean(error) && typeof error === 'object' && error.code === 'ENOENT'
}

function readEncrypted(file, { readFile, decrypt, missing = '' }) {
  let bytes
  try {
    bytes = readFile(file)
  } catch (error) {
    if (isMissingFile(error)) return missing
    throw error
  }
  return decrypt(bytes)
}

function writeEncrypted(file, json, { writeFile, rename, encrypt, remove }) {
  const temporary = `${file}.tmp`
  try {
    writeFile(temporary, encrypt(json), { mode: 0o600 })
    rename(temporary, file)
  } catch {
    try { remove(temporary) } catch { /* the temp file may not have been created */ }
    throw new Error('store_write_failed')
  }
}

module.exports = { readEncrypted, writeEncrypted }
