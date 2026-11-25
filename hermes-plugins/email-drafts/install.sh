#!/usr/bin/env bash
# Install or remove the email-drafts agent plugin in NAMED Hermes profiles only.
# Adapted for HermesBot from hermes-bot-kit (MIT, see NOTICE.md): dry run unless
# --apply, config.yaml backed up first, rules left at "everything needs approval".
#
#   bash hermes-plugins/email-drafts/install.sh --profiles alice --from you@example.com --account contact
#   bash hermes-plugins/email-drafts/install.sh --profiles alice --from you@example.com --account contact --apply
#   bash hermes-plugins/email-drafts/install.sh --profiles alice --uninstall --apply
#
# Options: --sent-folder NAME (save a copy after sending; default --no-save),
# --from-name "Name". The gateway loads the plugin on its next restart.
set -euo pipefail

HERMES_ROOT="${HERMES_ROOT:-${HOME}/.hermes}"
HERMES_BIN="${HERMES_BIN:-hermes}"
NAME="email-drafts"
SRC=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PROFILES="" FROM="" FROM_NAME="" ACCOUNT="" SENT=""
APPLY=0
UNINSTALL=0

usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --profiles) PROFILES="${2:-}"; shift 2 ;;
    --from) FROM="${2:-}"; shift 2 ;;
    --from-name) FROM_NAME="${2:-}"; shift 2 ;;
    --account) ACCOUNT="${2:-}"; shift 2 ;;
    --sent-folder) SENT="${2:-}"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "install.sh: unknown option $1" >&2; usage >&2; exit 2 ;;
  esac
done

[ -n "${PROFILES}" ] || { echo "install.sh: --profiles is required (no install into every profile)." >&2; exit 2; }
[ -f "${SRC}/engine.py" ] && grep -q "send_himalaya" "${SRC}/senders.py" || { echo "install.sh: ${SRC} is not the HermesBot email-drafts" >&2; exit 1; }
if [ "${UNINSTALL}" = 0 ]; then
  case "${FROM}" in *@*.*) ;; *) echo "install.sh: --from ADDRESS is required" >&2; exit 2 ;; esac
  case "${ACCOUNT}" in ""|*[!A-Za-z0-9_.@+-]*) [ -z "${ACCOUNT}" ] || { echo "install.sh: invalid --account" >&2; exit 2; } ;; esac
fi

run() {
  if [ "${APPLY}" = 1 ]; then "$@"; else printf 'would run:'; printf ' %q' "$@"; printf '\n'; fi
}

stamp=$(date +%Y%m%d-%H%M%S)
key="plugins.entries.${NAME}.settings"
IFS=',' read -r -a names <<< "${PROFILES}"
for raw in "${names[@]}"; do
  name=$(printf '%s' "${raw}" | tr -d '[:space:]')
  [ -n "${name}" ] || continue
  case "${name}" in *[!A-Za-z0-9_.-]*|.*) echo "skip ${name}: invalid profile name" >&2; continue ;; esac
  if [ "${name}" = default ]; then home="${HERMES_ROOT}"; else home="${HERMES_ROOT}/profiles/${name}"; fi
  [ -f "${home}/config.yaml" ] || { echo "skip ${name}: no ${home}/config.yaml" >&2; continue; }
  echo "== ${name} (${home})"
  run cp -p "${home}/config.yaml" "${home}/config.yaml.bak-email-drafts-${stamp}"
  if [ "${UNINSTALL}" = 1 ]; then
    run "${HERMES_BIN}" --profile "${name}" plugins disable "${NAME}"
    run rm -rf "${home}/plugins/${NAME}"
    echo "   (drafts, rules and audit log stay in ${home}/plugin-data/${NAME})"
  else
    run mkdir -p "${home}/plugins/${NAME}"
    run rsync -a --delete --exclude '__pycache__' --exclude 'tests' --exclude 'install.sh' "${SRC}/" "${home}/plugins/${NAME}/"
    run "${HERMES_BIN}" --profile "${name}" plugins enable "${NAME}"
    run "${HERMES_BIN}" --profile "${name}" config set "${key}.sender" himalaya
    run "${HERMES_BIN}" --profile "${name}" config set "${key}.from_address" "${FROM}"
    [ -z "${FROM_NAME}" ] || run "${HERMES_BIN}" --profile "${name}" config set "${key}.from_name" "${FROM_NAME}"
    [ -z "${ACCOUNT}" ] || run "${HERMES_BIN}" --profile "${name}" config set "${key}.himalaya_account" "${ACCOUNT}"
    [ -z "${SENT}" ] || run "${HERMES_BIN}" --profile "${name}" config set "${key}.himalaya_sent_folder" "${SENT}"
  fi
done
[ "${APPLY}" = 1 ] || echo "(dry run: nothing changed; add --apply)"
