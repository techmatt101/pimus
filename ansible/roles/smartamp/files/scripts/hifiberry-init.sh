#!/bin/sh
set -u

# Configuration is injected by the smartamp-hifiberry.service unit's
# Environment= lines, generated from inventory. Fail loudly if any is missing.
CARD="${HIFIBERRY_CARD_NAME:?HIFIBERRY_CARD_NAME is required}"
AUX_INPUT_LEFT="${HIFIBERRY_AUX_INPUT_LEFT:?HIFIBERRY_AUX_INPUT_LEFT is required}"
AUX_INPUT_RIGHT="${HIFIBERRY_AUX_INPUT_RIGHT:?HIFIBERRY_AUX_INPUT_RIGHT is required}"
AUX_GAIN_DB="${HIFIBERRY_AUX_GAIN_DB:?HIFIBERRY_AUX_GAIN_DB is required}"
OUTPUT_VOLUME_PERCENT="${HIFIBERRY_OUTPUT_VOLUME_PERCENT:?HIFIBERRY_OUTPUT_VOLUME_PERCENT is required}"
HAS_AUX="${HIFIBERRY_HAS_AUX:?HIFIBERRY_HAS_AUX is required}"

# A board with an ADC is only ready once its capture side has enumerated, which
# is what the ADC controls below need. A board without one has no capture device
# at all, so waiting for it would always time out; there, playback appearing is
# the readiness signal.
if [ "$HAS_AUX" = 1 ]; then
    PROBE=/usr/bin/arecord
else
    PROBE=/usr/bin/aplay
fi

card_present() {
    "$PROBE" -l 2>/dev/null | /usr/bin/grep -q "$CARD"
}

for _ in $(seq 1 30); do
    if card_present; then
        break
    fi
    /usr/bin/sleep 1
done

if ! card_present; then
    echo "HiFiBerry card $CARD was not detected" >&2
    exit 1
fi

if [ "$HAS_AUX" = 1 ]; then
    # Mixer control names are supplied by the ADC in the DAC2 ADC Pro driver.
    /usr/bin/amixer -q -c "$CARD" sset 'ADC Left Input' "$AUX_INPUT_LEFT"
    /usr/bin/amixer -q -c "$CARD" sset 'ADC Right Input' "$AUX_INPUT_RIGHT"
    /usr/bin/amixer -q -c "$CARD" sset 'ADC' "${AUX_GAIN_DB}dB"
fi

# Every supported board's DAC exposes this one, whatever else it carries.
/usr/bin/amixer -q -c "$CARD" sset 'Digital' "${OUTPUT_VOLUME_PERCENT}%"
/usr/sbin/alsactl store "$CARD"
