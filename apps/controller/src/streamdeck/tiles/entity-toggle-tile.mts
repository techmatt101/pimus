import {requireEntity} from '../../actions/catalog.mjs'
import {isEntityOn} from '../../home-assistant/entity.mjs'
import {ArmedControl} from '../armed-control.mjs'
import {type Binding, haBinding} from '../bindings.mjs'
import {DynamicDial, entityDial} from '../dials/dynamic-dial.mjs'
import {drawBar, drawIcon, drawRadialGradient, type Surface, withAlpha} from '../surface.mjs'
import {drawActiveGlow, drawBackground, drawCaption, drawLabelFace, FACE_CENTER, type Tile, type TileHost,} from '../tile.mjs'
import type {IconName} from '../icon-set.mjs'
import type {Action, HomeAssistantEntity, HomeAssistantService} from '../../types.mjs'

export interface EntityToggleTileConfig {
    label: string
    entity: string
    icon: IconName
    onColor?: string
    offColor?: string

    /**
     * Turns clockwise to draw the icon at, derived from `phase` — the
     * milliseconds the animation has been running. Pair with
     * `animationMilliseconds` to keep it turning.
     */
    spin?(entity: HomeAssistantEntity | undefined, phase: number): number

    /** A 0..1 reading shown as a bar under the icon, or undefined for none. */
    level?(entity: HomeAssistantEntity | undefined): number | undefined

    /**
     * Replaces the default `LABEL ON/OFF`/`LABEL ?` caption, e.g. a fan's speed
     * or a cover's open/closed. `on` is undefined for the unknown state.
     */
    caption?(entity: HomeAssistantEntity | undefined, on: boolean | undefined): string | undefined

    /** Repaint interval while the entity is on, for an animated icon. */
    animationMilliseconds?: number
    /** The shared dial this key hands its entity to when pressed. */
    dial?: DynamicDial
}

const UNKNOWN_COLOR = '#1a1a1a'
const UNKNOWN_ICON = '#424242'

const ICON_SIZE = 54
const LEVEL_Y = 78
const LEVEL_WIDTH = 64
const LEVEL_HEIGHT = 5

export class EntityToggleTile implements Tile {
    readonly #ha: HomeAssistantService
    readonly #config: EntityToggleTileConfig
    readonly #entity: string
    readonly #toggle: Binding
    // Present only when the key both has the shared dial and controls a domain
    // the dial can turn; a plain switch (a PC key) has neither and just toggles.
    readonly #armed: ArmedControl | null
    #host: TileHost | null = null
    #unwatch: (() => void) | null = null
    #animation: NodeJS.Timeout | null = null
    #phase = 0

    constructor(ha: HomeAssistantService, config: EntityToggleTileConfig) {
        this.#ha = ha
        this.#config = config
        this.#entity = requireEntity(config.entity, `${config.label} tile`)
        this.#toggle = haBinding(ha, 'toggle', this.#entity)
        const dial = config.dial ? entityDial(ha, config.label, this.#entity) : null
        this.#armed = config.dial && dial
            ? new ArmedControl(config.dial, dial, () => this.#toggle.run())
            : null
    }

    action(): Action {
        return this.#toggle.action
    }

    press(): void {
        // First press arms the dial so the strip shows what this key controls
        // and turning adjusts it; the next press toggles. A key with no
        // adjustable dial has nothing to arm, so it toggles at once.
        if (this.#armed) this.#armed.press()
        else this.#toggle.run()
    }

    holdsDial(): boolean {
        return this.#armed?.armed ?? false
    }

    mount(host: TileHost): void {
        this.#host = host
        this.#unwatch = this.#ha.watch([this.#entity], () => {
            this.#followState()
            host.invalidate()
        })
        this.#followState()
    }

    unmount(): void {
        this.#unwatch?.()
        this.#unwatch = null
        this.#stopAnimation()
        this.#armed?.release()
        this.#host = null
    }

    #followState(): void {
        if (this.#config.animationMilliseconds && isEntityOn(this.#ha.entity(this.#entity))) {
            this.#startAnimation(this.#config.animationMilliseconds)
        } else {
            this.#stopAnimation()
        }
    }

    #startAnimation(interval: number): void {
        if (this.#animation) return
        this.#phase = 0
        this.#animation = setInterval(() => this.#host?.invalidate(), interval)
        this.#animation.unref()
    }

    #stopAnimation(): void {
        if (this.#animation) clearInterval(this.#animation)
        this.#animation = null
    }

    draw(surface: Surface, deltaTime: number): void {
        const {label, icon: iconName, onColor = '#1b5e20', offColor = '#12281a'} = this.#config
        const entity = this.#ha.entity(this.#entity)
        const on = isEntityOn(entity)
        this.#phase += deltaTime
        const spin = on ? this.#config.spin?.(entity, this.#phase) ?? 0 : 0
        const x = surface.width / 2

        if (on === undefined) {
            drawLabelFace(surface, UNKNOWN_COLOR, this.#config.caption?.(entity, undefined) ?? `${label} ?`)
            drawIcon(surface, iconName, {x, y: FACE_CENTER, size: ICON_SIZE, color: UNKNOWN_ICON, rotate: spin})
            this.#drawArmed(surface)
            return
        }

        drawBackground(surface, on ? onColor : offColor)
        if (on) {
            surface.fill(drawRadialGradient(surface, x, FACE_CENTER, 58, withAlpha('#ffffff', 0.16), withAlpha('#ffffff', 0)))
        }
        drawIcon(surface, iconName, {
            x,
            y: FACE_CENTER,
            size: ICON_SIZE,
            color: on ? '#ffffff' : '#607d8b',
            rotate: spin,
        })

        const level = this.#config.level?.(entity)
        if (level !== undefined) {
            drawBar(surface, level, {
                x: x - LEVEL_WIDTH / 2,
                y: LEVEL_Y,
                width: LEVEL_WIDTH,
                height: LEVEL_HEIGHT,
                color: on ? '#ffffff' : '#546e7a',
                track: withAlpha('#000000', 0.45),
                rounded: true,
            })
        }

        drawCaption(surface, this.#config.caption?.(entity, on) ?? `${label} ${on ? 'ON' : 'OFF'}`)
        this.#drawArmed(surface)
    }

    #drawArmed(surface: Surface): void {
        if (this.#armed?.armed) drawActiveGlow(surface)
    }
}
