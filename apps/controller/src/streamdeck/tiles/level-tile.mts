import {ArmedControl} from '../armed-control.mjs'
import {DynamicDial} from '../dials/dynamic-dial.mjs'
import type {IconName} from '../icon-set.mjs'
import {LevelDial} from '../level-dial.mjs'
import {fittingSize, drawIcon, type Surface, drawText} from '../surface.mjs'
import {drawActiveGlow, drawBackground, drawCaption, FACE_CENTER, type Tile} from '../tile.mjs'

const READING_Y = FACE_CENTER + 22
const BAR_Y = 84
const BAR_HEIGHT = 4
const BAR_INSET = 12

/** A level this amp only reports draws in slate, so it never invites a press. */
const READONLY_INK = '#b0bec5'

export interface LevelTileConfig {
    label: string
    icon: IconName
    color: string
    /** The level to show, or undefined while whatever holds it is unreachable. */
    read: () => number | undefined
    /** Omit for a level this amp reports but nothing here may change. */
    apply?: (percent: number) => void
    /** A second line under the reading, for what the level is a share of. */
    caption?: () => string
}

/**
 * One gain on the amp's path, shown as a percentage and adjusted in place.
 * Press to arm: the shared dial steps it live in 5% notches, clamped at the
 * ends; press again — the key or the knob — to finish. A tile with no `apply`
 * is a readout: it draws the same face dimmed and its press does nothing, so a
 * level the amp only reports never looks like one that failed to move.
 */
export class LevelTile implements Tile {
    readonly #config: LevelTileConfig
    readonly #armed: ArmedControl | null

    constructor(config: LevelTileConfig, dial?: DynamicDial) {
        this.#config = config
        const {apply} = config
        if (apply === undefined || dial === undefined) {
            this.#armed = null
            return
        }
        const control = new LevelDial(config.label, {
            read: config.read,
            apply,
            onConfirm: () => this.#armed?.release(),
        })
        this.#armed = new ArmedControl(dial, control, () => this.#armed?.release())
    }

    press(): void {
        this.#armed?.press()
    }

    holdsDial(): boolean {
        return this.#armed?.armed === true
    }

    unmount(): void {
        this.#armed?.release()
    }

    draw(surface: Surface): void {
        const {label, icon, color, read, caption} = this.#config
        const level = read()
        const adjustable = this.#armed !== null
        const x = surface.width / 2
        drawBackground(surface, color)
        drawIcon(surface, icon, {x, y: 28, size: 30, color: adjustable ? '#ffffff' : READONLY_INK})
        // An unreachable audio manager reads as unknown, never as a level of zero.
        const value = level === undefined ? '?' : `${level}%`
        drawText(surface, value, {
            x,
            y: READING_Y,
            size: fittingSize(value, [30, 26, 22], 112),
            color: adjustable ? '#ffffff' : READONLY_INK,
        })
        this.#drawBar(surface, level)
        drawCaption(surface, caption ? caption() : label)

        if (this.holdsDial()) drawActiveGlow(surface)
    }

    #drawBar(surface: Surface, level: number | undefined): void {
        const {ctx} = surface
        const width = surface.width - BAR_INSET * 2
        ctx.save()
        ctx.fillStyle = 'rgba(0,0,0,0.45)'
        ctx.fillRect(BAR_INSET, BAR_Y, width, BAR_HEIGHT)
        if (level !== undefined) {
            ctx.fillStyle = this.#armed === null ? READONLY_INK : '#ffffff'
            ctx.fillRect(BAR_INSET, BAR_Y, (width * Math.max(0, Math.min(100, level))) / 100, BAR_HEIGHT)
        }
        ctx.restore()
    }
}
