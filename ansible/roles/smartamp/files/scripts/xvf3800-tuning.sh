#!/bin/sh
set -eu

# Applies the XVF3800's echo-canceller tuning. Every value the array accepts
# over USB is volatile - a power cycle (the controller cuts USB power in sleep)
# or a chip reboot restores Seeed's defaults - and save_configuration must
# never be used on this firmware (docs/xvf3800.md). So the values live in
# inventory, and a udev rule runs this on every enumeration of the device.
#
# Configuration is injected by the smartamp-xvf3800-tuning.service unit's
# Environment= lines, generated from inventory. Fail loudly if any is missing.
SYS_DELAY="${XVF3800_SYS_DELAY:?XVF3800_SYS_DELAY is required}"
REF_GAIN="${XVF3800_REF_GAIN:?XVF3800_REF_GAIN is required}"
MIC_GAIN="${XVF3800_MIC_GAIN:?XVF3800_MIC_GAIN is required}"
CARD_MATCH="${XVF3800_CARD_MATCH:?XVF3800_CARD_MATCH is required}"

# The control interface answers before the audio class driver has finished
# binding, and neither is up the instant udev sees the device.
for _ in $(seq 1 30); do
    if /usr/local/bin/xvf_host VERSION >/dev/null 2>&1; then
        break
    fi
    /usr/bin/sleep 1
done
/usr/local/bin/xvf_host VERSION

# Reference-versus-microphone delay in 16 kHz samples (negative delays the
# microphones), then the gains the canceller sees: the reference's, set so it
# peaks just under full scale at the loudest playback, and the microphones',
# set so they peak about 6 dB below it.
/usr/local/bin/xvf_host AUDIO_MGR_SYS_DELAY "$SYS_DELAY"
/usr/local/bin/xvf_host AUDIO_MGR_REF_GAIN "$REF_GAIN"
/usr/local/bin/xvf_host AUDIO_MGR_MIC_GAIN "$MIC_GAIN"

# The firmware takes AEC_FAR_EXTGAIN - how much it believes the reference has
# been attenuated outside the chip - from the card's second, mono "PCM Playback
# Volume" control (index 1), which nothing else drives and which also
# attenuates the reference inside the device. The restored ALSA state held it
# at -20 dB. The reference reaches the array at unity, so this says so, and
# the stored state is updated so the next alsactl restore agrees.
card_number() {
    /usr/bin/awk -v match_text="$CARD_MATCH" \
        'index($0, match_text) { gsub(/[^0-9]/, "", $1); print $1; exit }' \
        /proc/asound/cards
}
for _ in $(seq 1 30); do
    if [ -n "$(card_number)" ]; then
        break
    fi
    /usr/bin/sleep 1
done
CARD="$(card_number)"
if [ -z "$CARD" ]; then
    echo "No ALSA card matching $CARD_MATCH appeared" >&2
    exit 1
fi
/usr/bin/sleep 1
/usr/bin/amixer -q -c "$CARD" cset "name='PCM Playback Volume',index=1" 100%
/usr/sbin/alsactl store "$CARD"

for command in AUDIO_MGR_SYS_DELAY AUDIO_MGR_REF_GAIN AUDIO_MGR_MIC_GAIN AEC_FAR_EXTGAIN; do
    /usr/local/bin/xvf_host "$command"
done
