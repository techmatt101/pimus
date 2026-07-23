#!/bin/sh
set -eu

# Linux Voice Assistant treats an explicit device name as a literal device
# lookup. Wait for the router to select PipeWire's defaults, then start LVA
# without device arguments so its audio library resolves those defaults.
status_file="${1:?audio status file is required}"
timeout_seconds="${2:-60}"
elapsed=0

while [ "$elapsed" -lt "$timeout_seconds" ]; do
  if [ -r "$status_file" ] && jq -e \
    '(.sink | type == "string" and length > 0) and
     (.voice_input | type == "string" and length > 0)' \
    "$status_file" >/dev/null 2>&1; then
    exit 0
  fi

  sleep 1
  elapsed=$((elapsed + 1))
done

echo "Audio routing did not become ready within ${timeout_seconds}s" >&2
exit 1
