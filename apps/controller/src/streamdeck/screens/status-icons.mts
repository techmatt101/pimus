import {drawIcon, type Surface} from '../surface.mjs'
import type {IconName} from '../icon-set.mjs'
import type {ControlState} from '../../types.mjs'

const OK_COLOR = '#607d8b'
const ALERT_COLOR = '#ef5350'
const USB_PLAYBACK_COLOR = '#26c6da'

const FLASH_PERIOD_MILLISECONDS = 1000
const FLASH_FLOOR = 0.12
export const STATUS_FLASH_FRAME_MILLISECONDS = 60

interface StatusSlot {
    icon: IconName
    color: string
    /** Red and pulsing: something that should be up is not. */
    fault: boolean
    /** Red but steady: a mute is deliberate, not a failure. */
    muted: boolean
}

function slots(state: ControlState): StatusSlot[] {
    const {health, muted, outputMuted} = state
    const row: StatusSlot[] = [
        {icon: 'wifi', color: OK_COLOR, fault: !health.network, muted: false},
        {icon: 'home', color: OK_COLOR, fault: !health.ha, muted: false},
        {icon: muted ? 'micOff' : 'mic', color: OK_COLOR, fault: false, muted},
        {icon: outputMuted ? 'volumeMute' : 'volume', color: OK_COLOR, fault: !health.audio, muted: outputMuted},
    ]
    // Informational, never a fault: present only while a computer is actively
    // streaming audio to the USB-C gadget port. Enumeration alone is not
    // shown because the VBUS-blocked port never reports an unplug.
    if (health.usbPlayback) {
        row.push({icon: 'usb', color: USB_PLAYBACK_COLOR, fault: false, muted: false})
    }
    return row
}

export function hasFault(state: ControlState): boolean {
    return slots(state).some((slot) => slot.fault)
}

export interface StatusIconOptions {
    x: number
    y: number
    size: number
    gap: number
    /** Animation time accumulated by the screen, which is what pulses a red icon. */
    phase: number
    /** Draw only the slots that are red, for faces with no room for a full row. */
    alertsOnly?: boolean
}

function faultOpacity(phase: number): number {
    const step = (phase % FLASH_PERIOD_MILLISECONDS) / FLASH_PERIOD_MILLISECONDS
    return FLASH_FLOOR + (1 - FLASH_FLOOR) * (0.5 + 0.5 * Math.cos(step * 2 * Math.PI))
}

export function drawStatusIcons(surface: Surface, state: ControlState, options: StatusIconOptions): void {
    const {x, y, size, gap, phase, alertsOnly = false} = options
    let at = x
    for (const slot of slots(state)) {
        if (alertsOnly && !slot.fault && !slot.muted) continue
        drawIcon(surface, slot.icon, {
            x: at,
            y,
            size,
            color: slot.fault || slot.muted ? ALERT_COLOR : slot.color,
            opacity: slot.fault ? faultOpacity(phase) : undefined,
        })
        at += size + gap
    }
}
