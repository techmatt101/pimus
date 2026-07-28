export type ColorInput = number | string

/** Packs a `#rrggbb` string (or passes a packed number through) as 0xRRGGBB. */
export function rgb(value: ColorInput): number {
    if (typeof value === 'number') return value & 0xFFFFFF
    const parsed = Number.parseInt(value.replace(/^#/, ''), 16)
    return Number.isFinite(parsed) ? parsed & 0xFFFFFF : 0
}

/** Scales a packed colour towards black. */
export function scaleColor(color: number, factor: number): number {
    const f = Math.max(0, Math.min(1, factor))
    const channel = (shift: number) => Math.round(((color >> shift) & 0xFF) * f) << shift
    return channel(16) | channel(8) | channel(0)
}

/** Blends two packed colours, `amount` running from all of `from` to all of `to`. */
export function mixColor(from: number, to: number, amount: number): number {
    const t = Math.max(0, Math.min(1, amount))
    const channel = (shift: number) => {
        const start = (from >> shift) & 0xFF
        return Math.round(start + (((to >> shift) & 0xFF) - start) * t) << shift
    }
    return channel(16) | channel(8) | channel(0)
}
