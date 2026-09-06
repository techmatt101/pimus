#!/bin/sh
set -eu

# Linux Voice Assistant treats an explicit device name as a literal device
# lookup, so it is started without device arguments and its audio library
# resolves PipeWire's defaults. Wait for the audio manager to select the
# output side of those defaults, and for PipeWire's own configuration to have
# published every capture source named here (the array's capture node and, on
# a unit with a channel remap, the mono source lifted from it), so LVA does
# not open whatever happened to be the default first.
status_file="${1:?audio status file is required}"
timeout_seconds="${2:?timeout in seconds is required}"
shift 2
elapsed=0

playback_ready() {
  [ -r "$status_file" ] && jq -e \
    '(.sink | type == "string" and length > 0) and
     (.voice_bus.enabled == false or
      ((.voice_bus.sink | type == "string" and length > 0) and
       (.idle == true or .voice_bus.available == true)))' \
    "$status_file" >/dev/null 2>&1
}

capture_ready() {
  published=$(pactl list short sources 2>/dev/null | awk '{ print $2 }') || return 1
  for name in "$@"; do
    printf '%s\n' "$published" | grep -qxF -- "$name" || return 1
  done
}

while [ "$elapsed" -lt "$timeout_seconds" ]; do
  if playback_ready && capture_ready "$@"; then
    exit 0
  fi

  sleep 1
  elapsed=$((elapsed + 1))
done

echo "Audio routing did not become ready within ${timeout_seconds}s" >&2
exit 1
