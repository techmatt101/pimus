// The icon set the tiles draw with. Every icon is drawn from the primitives in
// bitmap.mts rather than decoded from a file, so the controller ships no binary
// assets and needs no image decoder on the Pi.
//
// An icon draws itself centred on (centerX, centerY) in one colour, and takes a
// `phase` — a 0..1 position in an animation cycle — so an animated icon such as
// the fan stays a pure function of its arguments. A still tile passes nothing
// and gets the resting appearance.

import { drawCircle, drawLine, drawRectangle } from './bitmap.mjs'
import type { Bitmap } from '../types.mjs'

export type Icon = (
  target: Bitmap,
  centerX: number,
  centerY: number,
  value: string,
  phase?: number,
) => void

/** A microphone: a capsule on a stand. */
export const micIcon: Icon = (target, cx, cy, value) => {
  drawRectangle(target, cx - 7, cy - 22, 14, 26, value)
  drawCircle(target, cx, cy - 22, 7, value, { filled: true })
  drawCircle(target, cx, cy + 4, 7, value, { filled: true })
  drawCircle(target, cx, cy - 2, 15, value, { to: 0.5, thickness: 3 })
  drawLine(target, cx, cy + 13, cx, cy + 22, value, 3)
  drawLine(target, cx - 9, cy + 22, cx + 9, cy + 22, value, 3)
}

/** Two crossing paths with arrowheads on the right: the shuffle glyph. */
export const shuffleIcon: Icon = (target, cx, cy, value) => {
  drawLine(target, cx - 24, cy - 13, cx + 8, cy + 13, value, 4)
  drawLine(target, cx - 24, cy + 13, cx + 8, cy - 13, value, 4)
  for (const dy of [-13, 13]) {
    // A solid right-pointing head, drawn column by column so it tapers.
    for (let step = 0; step <= 11; step += 1) {
      const half = Math.round((1 - step / 11) * 7)
      drawRectangle(target, cx + 8 + step, cy + dy - half, 1, half * 2 + 1, value)
    }
  }
}

/** A ceiling fan seen from below; `phase` turns the blades. */
export const fanIcon: Icon = (target, cx, cy, value, phase = 0) => {
  const turn = phase * 2 * Math.PI
  for (let blade = 0; blade < 3; blade += 1) {
    const angle = turn + (blade * 2 * Math.PI) / 3
    const tipX = cx + Math.cos(angle) * 24
    const tipY = cy + Math.sin(angle) * 24
    // Widening towards the tip reads as a blade rather than a spoke.
    drawLine(target, cx, cy, (cx + tipX) / 2, (cy + tipY) / 2, value, 5)
    drawLine(target, (cx + tipX) / 2, (cy + tipY) / 2, tipX, tipY, value, 9)
  }
  drawCircle(target, cx, cy, 6, value, { filled: true })
}

/** A window blind: a headrail over slats, lowered by `phase` (0 open, 1 shut). */
export const blindsIcon: Icon = (target, cx, cy, value, phase = 1) => {
  const width = 46
  drawRectangle(target, cx - width / 2, cy - 24, width, 5, value)
  const slats = Math.round(phase * 6)
  for (let slat = 0; slat < slats; slat += 1) {
    drawRectangle(target, cx - width / 2, cy - 15 + slat * 8, width, 5, value)
  }
}

/** A desktop monitor on a stand. */
export const monitorIcon: Icon = (target, cx, cy, value) => {
  drawRectangle(target, cx - 24, cy - 20, 48, 32, value)
  drawRectangle(target, cx - 20, cy - 16, 40, 24, '#000000')
  drawRectangle(target, cx - 5, cy + 12, 10, 7, value)
  drawRectangle(target, cx - 16, cy + 19, 32, 4, value)
}

/** A lamp: a bulb over a base, for scene keys. */
export const bulbIcon: Icon = (target, cx, cy, value) => {
  drawCircle(target, cx, cy - 8, 15, value, { filled: true })
  drawRectangle(target, cx - 8, cy + 6, 16, 8, value)
  drawRectangle(target, cx - 6, cy + 15, 12, 4, value)
}

/** A beamed pair of quavers, for a playlist shortcut. */
export const noteIcon: Icon = (target, cx, cy, value) => {
  drawRectangle(target, cx - 10, cy - 22, 4, 32, value)
  drawRectangle(target, cx + 12, cy - 22, 4, 32, value)
  drawRectangle(target, cx - 10, cy - 22, 26, 6, value)
  drawCircle(target, cx - 14, cy + 10, 7, value, { filled: true })
  drawCircle(target, cx + 8, cy + 10, 7, value, { filled: true })
}

/** A chevron pair pointing the way a page key moves; `forward` points right. */
export const pageIcon = (forward: boolean): Icon => (target, cx, cy, value) => {
  const sign = forward ? 1 : -1
  for (const offset of [-10, 4]) {
    const x = cx + sign * offset
    drawLine(target, x, cy - 14, x + sign * 12, cy, value, 4)
    drawLine(target, x + sign * 12, cy, x, cy + 14, value, 4)
  }
}

/** A thermometer: a stem over a bulb, filled to `phase` of its scale. */
export const thermometerIcon: Icon = (target, cx, cy, value, phase = 0.5) => {
  drawRectangle(target, cx - 5, cy - 24, 10, 30, '#ffffff')
  drawCircle(target, cx, cy + 10, 10, '#ffffff', { filled: true })
  drawCircle(target, cx, cy + 10, 7, value, { filled: true })
  const height = Math.max(1, Math.round(Math.min(1, Math.max(0, phase)) * 26))
  drawRectangle(target, cx - 3, cy + 4 - height, 6, height, value)
}

/** A weather condition glyph chosen from a Home Assistant condition string. */
export function drawCondition(
  target: Bitmap,
  centerX: number,
  centerY: number,
  condition: string,
): void {
  const sun = (x: number, y: number, radius: number): void => {
    drawCircle(target, x, y, radius, '#ffd54f', { filled: true })
  }
  const cloud = (x: number, y: number, tone: string): void => {
    drawCircle(target, x - 12, y + 2, 10, tone, { filled: true })
    drawCircle(target, x + 2, y - 4, 14, tone, { filled: true })
    drawCircle(target, x + 15, y + 2, 10, tone, { filled: true })
    drawRectangle(target, x - 22, y + 2, 38, 10, tone)
  }
  const fall = (x: number, y: number, tone: string): void => {
    for (const offset of [-14, 0, 14]) drawLine(target, x + offset, y, x + offset - 4, y + 12, tone, 3)
  }

  if (condition.includes('sunny') || condition === 'clear-night') {
    sun(centerX, centerY, 22)
    if (condition === 'clear-night') drawCircle(target, centerX + 10, centerY - 8, 20, '#101820', { filled: true })
    return
  }
  if (condition.startsWith('partlycloudy')) {
    sun(centerX + 12, centerY - 12, 14)
    cloud(centerX - 4, centerY + 2, '#cfd8dc')
    return
  }
  if (condition.includes('rain') || condition.includes('pouring')) {
    cloud(centerX, centerY - 8, '#90a4ae')
    fall(centerX, centerY + 12, '#4fc3f7')
    return
  }
  if (condition.includes('snow')) {
    cloud(centerX, centerY - 8, '#cfd8dc')
    fall(centerX, centerY + 12, '#ffffff')
    return
  }
  if (condition.includes('lightning')) {
    cloud(centerX, centerY - 8, '#78909c')
    drawLine(target, centerX + 4, centerY + 8, centerX - 6, centerY + 20, '#ffd54f', 4)
    drawLine(target, centerX - 6, centerY + 20, centerX + 6, centerY + 18, '#ffd54f', 4)
    return
  }
  if (condition.includes('fog')) {
    for (const offset of [-10, 0, 10]) {
      drawRectangle(target, centerX - 24, centerY + offset, 48, 5, '#b0bec5')
    }
    return
  }
  // cloudy, windy, hail, exceptional, and anything upstream adds later.
  cloud(centerX, centerY, '#b0bec5')
}
