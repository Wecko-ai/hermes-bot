// Electron fuses flipped in afterPack, before the ad-hoc signature.
// RunAsNode, NODE_OPTIONS, and --inspect are off. OnlyLoadAppFromAsar and
// EnableEmbeddedAsarIntegrityValidation stay untouched: the asar hash lives in an
// unsigned Info.plist on this install. electron-builder's `electronFuses` key stays
// unset so it does not flip the wire again after signing.
// resetAdHocDarwinSignature lets an arm64 package launch after the wire changes.

const { FuseVersion, FuseV1Options, flipFuses } = require('@electron/fuses')

const DISABLED_FUSES = Object.freeze([
  FuseV1Options.RunAsNode,
  FuseV1Options.EnableNodeOptionsEnvironmentVariable,
  FuseV1Options.EnableNodeCliInspectArguments,
])

function packagedFuseConfig({ resetAdHocDarwinSignature = true } = {}) {
  const config = {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature,
  }
  for (const fuse of DISABLED_FUSES) config[fuse] = false
  return config
}

function flipPackagedFuses(electronPath, deps = {}) {
  const flip = deps.flipFuses || flipFuses
  return flip(electronPath, packagedFuseConfig())
}

/** Darwin afterPack: flip fuses first, then sign when a mode is configured. */
async function afterPackDarwin({ platform, appPath, macSign, signApp, flip = flipPackagedFuses }) {
  if (platform !== 'darwin') return
  await flip(appPath)
  if (macSign) await signApp(appPath, macSign)
}

module.exports = {
  DISABLED_FUSES,
  packagedFuseConfig,
  flipPackagedFuses,
  afterPackDarwin,
  FuseV1Options,
  FuseVersion,
}
