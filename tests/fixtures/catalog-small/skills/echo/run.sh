#!/usr/bin/env bash
set -euo pipefail
msg="${1:-}"
if [[ -z "$msg" ]]; then
  echo "usage: run.sh <message>" >&2
  exit 2
fi
printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$msg"
