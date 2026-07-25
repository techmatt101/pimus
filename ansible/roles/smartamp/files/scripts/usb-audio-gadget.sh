#!/bin/sh
set -eu

# Configuration is injected by the smartamp-usb-audio-gadget.service unit's
# Environment= lines, generated from inventory. Fail loudly if any is missing.
PRODUCT="${USB_AUDIO_PRODUCT:?USB_AUDIO_PRODUCT is required}"
SAMPLE_RATE="${USB_AUDIO_SAMPLE_RATE:?USB_AUDIO_SAMPLE_RATE is required}"
SAMPLE_SIZE_BYTES="${USB_AUDIO_SAMPLE_SIZE_BYTES:?USB_AUDIO_SAMPLE_SIZE_BYTES is required}"

GADGET=/sys/kernel/config/usb_gadget/smartamp

start_gadget() {
    /usr/sbin/modprobe libcomposite
    /usr/bin/mountpoint -q /sys/kernel/config || /usr/bin/mount -t configfs none /sys/kernel/config

    if [ -d "$GADGET" ]; then
        UDC=$(/usr/bin/ls /sys/class/udc | /usr/bin/head -n 1)
        [ -n "$UDC" ] || { echo 'No USB device controller found' >&2; exit 1; }
        printf '%s' "$UDC" > "$GADGET/UDC"
        return 0
    fi

    /usr/bin/mkdir -p "$GADGET"
    cd "$GADGET"
    printf '0x1d6b' > idVendor
    printf '0x0104' > idProduct
    printf '0x0100' > bcdDevice
    printf '0x0200' > bcdUSB

    /usr/bin/mkdir -p strings/0x409
    /usr/bin/awk '/Serial/ {print $3}' /proc/cpuinfo > strings/0x409/serialnumber
    printf 'Pimus' > strings/0x409/manufacturer
    printf '%s' "$PRODUCT" > strings/0x409/product

    /usr/bin/mkdir -p configs/c.1/strings/0x409
    printf 'UAC2 stereo input' > configs/c.1/strings/0x409/configuration
    printf '100' > configs/c.1/MaxPower

    /usr/bin/mkdir -p functions/uac2.usb0
    # f_uac2 names its directions after the gadget's own ALSA card: "capture"
    # (c_*) is audio the USB host plays into the Pi, "playback" (p_*) would
    # stream the Pi to the host as a microphone. Enable only the inbound path.
    printf '0x3' > functions/uac2.usb0/c_chmask
    printf '0x0' > functions/uac2.usb0/p_chmask
    printf '%s' "$SAMPLE_RATE" > functions/uac2.usb0/c_srate
    printf '%s' "$SAMPLE_SIZE_BYTES" > functions/uac2.usb0/c_ssize
    [ ! -e configs/c.1/uac2.usb0 ] && /usr/bin/ln -s functions/uac2.usb0 configs/c.1/

    UDC=$(/usr/bin/ls /sys/class/udc | /usr/bin/head -n 1)
    if [ -z "$UDC" ]; then
        echo 'No USB device controller found; is dtoverlay=dwc2,dr_mode=peripheral active?' >&2
        exit 1
    fi
    printf '%s' "$UDC" > UDC
}

stop_gadget() {
    if [ -f "$GADGET/UDC" ]; then
        printf '' > "$GADGET/UDC"
    fi
}

case "${1:-start}" in
    start) start_gadget ;;
    stop) stop_gadget ;;
    *) echo "usage: $0 [start|stop]" >&2; exit 2 ;;
esac
