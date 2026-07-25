import {drawIcon, type Surface} from '../surface.mjs'
import type {IconName} from '../icon-set.mjs'
import type {HealthState} from '../../types.mjs'

const OK_COLOR = '#37474f'
const FAULT_COLOR = '#ef5350'
const USB_ATTACHED_COLOR = '#26c6da'

interface StatusSlot {
    icon: IconName
    color: string
    fault: boolean
}

function slots(health: HealthState): StatusSlot[] {
    return [
        {icon: 'wifi', color: OK_COLOR, fault: !health.network},
        {icon: 'home', color: OK_COLOR, fault: !health.ha},
        {icon: 'volume', color: OK_COLOR, fault: !health.audio},
        // Informational, never a fault: lit while a computer is enumerated on
        // the USB-C gadget port.
        {icon: 'usb', color: health.usbHost ? USB_ATTACHED_COLOR : OK_COLOR, fault: false},
    ]
}

export interface StatusIconOptions {
    x: number
    y: number
    size: number
    gap: number
    /** Draw only the slots that are red, for faces with no room for a full row. */
    faultsOnly?: boolean
}

export function drawStatusIcons(surface: Surface, health: HealthState, options: StatusIconOptions): void {
    const {x, y, size, gap, faultsOnly = false} = options
    let at = x
    for (const slot of slots(health)) {
        if (faultsOnly && !slot.fault) continue
        drawIcon(surface, slot.icon, {x: at, y, size, color: slot.fault ? FAULT_COLOR : slot.color})
        at += size + gap
    }
}
