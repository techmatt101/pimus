import {drawIcon, type Surface} from '../surface.mjs'
import type {IconName} from '../icon-set.mjs'
import type {ControlState} from '../../types.mjs'

const OK_COLOR = '#607d8b'
const ALERT_COLOR = '#ef5350'
const USB_ATTACHED_COLOR = '#26c6da'

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
    return [
        {icon: 'wifi', color: OK_COLOR, fault: !health.network, muted: false},
        {icon: 'home', color: OK_COLOR, fault: !health.ha, muted: false},
        {icon: muted ? 'micOff' : 'mic', color: OK_COLOR, fault: false, muted},
        {icon: outputMuted ? 'volumeMute' : 'volume', color: OK_COLOR, fault: !health.audio, muted: outputMuted},
        // Informational, never a fault: lit while a computer is enumerated on
        // the USB-C gadget port.
        {icon: 'usb', color: health.usbHost ? USB_ATTACHED_COLOR : OK_COLOR, fault: false, muted: false},
    ]
}

export function hasFault(state: ControlState): boolean {
    return slots(state).some((slot) => slot.fault)
}

export interface StatusIconOptions {
    x: number
    y: number
    size: number
    gap: number
    /** The instant of this repaint, which is what pulses a red icon. */
    now: number
    /** Draw only the slots that are red, for faces with no room for a full row. */
    alertsOnly?: boolean
}

function faultOpacity(now: number): number {
    const phase = (now % FLASH_PERIOD_MILLISECONDS) / FLASH_PERIOD_MILLISECONDS
    return FLASH_FLOOR + (1 - FLASH_FLOOR) * (0.5 + 0.5 * Math.cos(phase * 2 * Math.PI))
}

export function drawStatusIcons(surface: Surface, state: ControlState, options: StatusIconOptions): void {
    const {x, y, size, gap, now, alertsOnly = false} = options
    let at = x
    for (const slot of slots(state)) {
        if (alertsOnly && !slot.fault && !slot.muted) continue
        drawIcon(surface, slot.icon, {
            x: at,
            y,
            size,
            color: slot.fault || slot.muted ? ALERT_COLOR : slot.color,
            opacity: slot.fault ? faultOpacity(now) : undefined,
        })
        at += size + gap
    }
}
