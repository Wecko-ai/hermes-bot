#!/usr/bin/env bash
# Install or remove the texting-style agent plugin in NAMED Hermes profiles only.
# Adapted for HermesBot from hermes-bot-kit (MIT, see NOTICE.md): never every
# profile at once, dry run unless --apply, config.yaml backed up before enabling.
#
#   bash hermes-plugins/texting-style/install.sh --profiles alice,orion            # dry run
#   bash hermes-plugins/texting-style/install.sh --profiles alice,orion --apply    # install + enable
#   bash hermes-plugins/texting-style/install.sh --profiles alice --uninstall --apply
#
# Takes effect on the next message of each Bot Chat once the profile's agent
# process reloads its plugins (gateway restart, or `hermes reload-plugins`).
set -euo pipefail

HERMES_ROOT="${HERMES_ROOT:-${HOME}/.hermes}"
HERMES_BIN="${HERMES_BIN:-hermes}"
NAME="texting-style"
SRC=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PROFILES=""
APPLY=0
UNINSTALL=0

usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --profiles) PROFILES="${2:-}"; shift 2 ;;
    --profiles=*) PROFILES="${1#--profiles=}"; shift ;;
    --apply) APPLY=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "install.sh: unknown option $1" >&2; usage >&2; exit 2 ;;
  esac
done

[ -n "${PROFILES}" ] || { echo "install.sh: --profiles is required (no install into every profile)." >&2; exit 2; }
grep -q "texting-style.sms-register" "${SRC}/__init__.py" || { echo "install.sh: ${SRC} is not texting-style" >&2; exit 1; }

run() {
  if [ "${APPLY}" = 1 ]; then "$@"; else printf 'would run:'; printf ' %q' "$@"; printf '\n'; fi
}

stamp=$(date +%Y%m%d-%H%M%S)
IFS=',' read -r -a names <<< "${PROFILES}"
for raw in "${names[@]}"; do
  name=$(printf '%s' "${raw}" | tr -d '[:space:]')
  [ -n "${name}" ] || continue
  case "${name}" in *[!A-Za-z0-9_.-]*|.*) echo "skip ${name}: invalid profile name" >&2; continue ;; esac
  if [ "${name}" = default ]; then home="${HERMES_ROOT}"; else home="${HERMES_ROOT}/profiles/${name}"; fi
  [ -f "${home}/config.yaml" ] || { echo "skip ${name}: no ${home}/config.yaml" >&2; continue; }
  echo "== ${name} (${home})"
  run cp -p "${home}/config.yaml" "${home}/config.yaml.bak-texting-style-${stamp}"
  if [ "${UNINSTALL}" = 1 ]; then
    run "${HERMES_BIN}" --profile "${name}" plugins disable "${NAME}"
    run rm -rf "${home}/plugins/${NAME}"
  else
    run mkdir -p "${home}/plugins/${NAME}"
    run cp -p "${SRC}/__init__.py" "${SRC}/plugin.yaml" "${SRC}/NOTICE.md" "${SRC}/LICENSE" "${home}/plugins/${NAME}/"
    run "${HERMES_BIN}" --profile "${name}" plugins enable "${NAME}"
  fi
done
[ "${APPLY}" = 1 ] || echo "(dry run: nothing changed; add --apply)"
