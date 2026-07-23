#!/bin/sh
set -u

# Configuration is injected by the smartamp-hifiberry.service unit's
# Environment= lines, generated from inventory. Fail loudly if any is missing.
CARD="${HIFIBERRY_CARD_NAME:?HIFIBERRY_CARD_NAME is required}"
AUX_INPUT_LEFT="${HIFIBERRY_AUX_INPUT_LEFT:?HIFIBERRY_AUX_INPUT_LEFT is required}"
AUX_INPUT_RIGHT="${HIFIBERRY_AUX_INPUT_RIGHT:?HIFIBERRY_AUX_INPUT_RIGHT is required}"
AUX_GAIN_DB="${HIFIBERRY_AUX_GAIN_DB:?HIFIBERRY_AUX_GAIN_DB is required}"
OUTPUT_VOLUME_PERCENT="${HIFIBERRY_OUTPUT_VOLUME_PERCENT:?HIFIBERRY_OUTPUT_VOLUME_PERCENT is required}"

for _ in $(seq 1 30); do
    if /usr/bin/arecord -l 2>/dev/null | /usr/bin/grep -q "$CARD"; then
        break
    fi
    /usr/bin/sleep 1
done

if ! /usr/bin/arecord -l 2>/dev/null | /usr/bin/grep -q "$CARD"; then
    echo "HiFiBerry card $CARD was not detected" >&2
    exit 1
fi

# Mixer control names are supplied by the DAC2 ADC Pro kernel driver.
/usr/bin/amixer -q -c "$CARD" sset 'ADC Left Input' "$AUX_INPUT_LEFT"
/usr/bin/amixer -q -c "$CARD" sset 'ADC Right Input' "$AUX_INPUT_RIGHT"
/usr/bin/amixer -q -c "$CARD" sset 'ADC' "${AUX_GAIN_DB}dB"
/usr/bin/amixer -q -c "$CARD" sset 'Digital' "${OUTPUT_VOLUME_PERCENT}%"
/usr/sbin/alsactl store "$CARD"
