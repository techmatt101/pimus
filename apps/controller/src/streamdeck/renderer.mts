import type {StreamDeck} from '@elgato-stream-deck/node'

import {DynamicDial} from './dials/dynamic-dial.mjs'
import {PageDial, type PageNavigator} from './dials/page-dial.mjs'
import {type StreamDeckLayout, type StreamDeckPage, tileAt,} from './grid.mjs'
import {STRIP_HEIGHT, STRIP_WIDTH} from './screens/screen.mjs'
import {Surface} from './surface.mjs'
import {KEY_SIZE, type Tile, type TileHost,} from './tile.mjs'
import type {ControlModel} from '../state.mjs'

const FORMAT = {format: 'rgba'} as const

export interface DeckRendererOptions {
    layout: StreamDeckLayout
    model: ControlModel
    logger?: Pick<Console, 'error'>
}

export class DeckRenderer implements PageNavigator {
    readonly layout: StreamDeckLayout
    readonly #model: ControlModel
    readonly #logger: Pick<Console, 'error'>
    #deck: StreamDeck | null = null
    #asleep = false
    #renderPending = false
    #lastBrightness: number | null = null
    #pageIndex = 0
    readonly #mounted = new Map<number, Tile>()
    readonly #keySurface = new Surface(KEY_SIZE, KEY_SIZE)
    readonly #stripSurface = new Surface(STRIP_WIDTH, STRIP_HEIGHT)
    readonly #now: () => number = Date.now
    readonly #lastKeyDrawAt = new Map<number, number>()
    #lastStripDrawAt = 0
    readonly #sharedDial: DynamicDial | null
    readonly #sharedDialIndex: number

    constructor({layout, model, logger = console}: DeckRendererOptions) {
        this.layout = layout
        this.#model = model
        this.#logger = logger
        this.#asleep = !model.state.awake
        for (const dial of layout.dials) if (dial instanceof PageDial) dial.connect(this)
        this.#sharedDialIndex = layout.dials.findIndex((dial) => dial instanceof DynamicDial)
        const shared = layout.dials[this.#sharedDialIndex]
        this.#sharedDial = shared instanceof DynamicDial ? shared : null
        this.#model.subscribe(() => {
            const wasAsleep = this.#asleep
            void this.#applyAwake()
            if (!this.#asleep && this.#asleep === wasAsleep) void this.#applyBrightness()
            this.schedule()
        })
    }

    async setDeck(deck: StreamDeck): Promise<void> {
        this.#deck = deck
        this.#asleep = !this.#model.state.awake
        if (!this.#asleep) this.#mountVisible()
        await this.render()
        await this.#applyBrightness()
    }

    clearDeck(deck: StreamDeck | null): void {
        if (this.#deck !== deck) return
        this.#deck = null
        this.#unmountVisible()
    }

    // The deck retains its last image, so waking must paint before raising the
    // brightness, and going dark must cut the brightness before dropping tiles.
    async #applyAwake(): Promise<void> {
        const asleep = !this.#model.state.awake
        if (asleep === this.#asleep) return
        this.#asleep = asleep
        if (!this.#deck) return
        if (asleep) {
            await this.#applyBrightness()
            this.#unmountVisible()
        } else {
            this.#mountVisible()
            await this.render()
            await this.#applyBrightness()
        }
    }

    #mountVisible(): void {
        this.#mountPage()
        this.layout.strip.mount({invalidate: () => void this.#renderStrip()})
    }

    #unmountVisible(): void {
        this.#unmountPage()
        this.layout.strip.unmount()
    }

    async #applyBrightness(): Promise<void> {
        const deck = this.#deck
        if (!deck) return
        const target = this.#asleep ? 0 : this.#model.state.brightness
        if (target === this.#lastBrightness) return
        this.#lastBrightness = target
        try {
            await deck.setBrightness(target)
        } catch (error) {
            // The level did not take, so forget it and leave the panel able to retry.
            this.#lastBrightness = null
            this.#logger.error('brightness failed', error)
        }
    }

    showDial(index: number): void {
        // Reaching for a different knob abandons a transient claim on the shared dial.
        if (this.#sharedDial && index !== this.#sharedDialIndex) this.#sharedDial.autoRelease()
        this.layout.strip.showDial(index)
    }

    stripPressAt(x: number): (() => unknown) | undefined {
        return this.layout.strip.pressAt(x)
    }

    #currentPage(): StreamDeckPage | undefined {
        return this.layout.pages[this.#pageIndex]
    }

    currentName(): string {
        return this.#pageNameAt(0)
    }

    #keyDelta(index: number, at: number): number {
        const last = this.#lastKeyDrawAt.get(index)
        this.#lastKeyDrawAt.set(index, at)
        return last === undefined ? 0 : at - last
    }

    #stripDelta(at: number): number {
        const last = this.#lastStripDrawAt
        this.#lastStripDrawAt = at
        return last === 0 ? 0 : at - last
    }

    // Returns a thunk rather than pressing immediately so the deck's dispatch
    // queue keeps presses in physical order.
    pressAt(index: number): (() => unknown) | undefined {
        const page = this.#currentPage()
        const tile = page ? tileAt(page.grid, index) : undefined
        if (!tile) return undefined
        return () => tile.press()
    }

    changePage(delta: number): void {
        const count = this.layout.pages.length
        if (count === 0) return
        this.#pageIndex = (((this.#pageIndex + delta) % count) + count) % count
        this.#mountPage()
        void this.render()
    }

    #mountPage(): void {
        this.#unmountPage()
        if (!this.#deck) return
        const page = this.#currentPage()
        if (!page) return
        for (let index = 0; index < 8; index += 1) {
            const tile = tileAt(page.grid, index)
            if (!tile) continue
            this.#mounted.set(index, tile)
            tile.mount?.(this.#hostFor(index))
        }
    }

    #hostFor(index: number): TileHost {
        return {
            invalidate: () => void this.#renderKey(index),
            changePage: (delta) => this.changePage(delta),
            pageName: (delta) => this.#pageNameAt(delta),
        }
    }

    #pageNameAt(delta: number): string {
        const count = this.layout.pages.length
        if (count === 0) return ''
        return this.layout.pages[(((this.#pageIndex + delta) % count) + count) % count]?.name ?? ''
    }

    #unmountPage(): void {
        for (const tile of this.#mounted.values()) tile.unmount?.()
        this.#mounted.clear()
        // The next page's keys start from a zero delta rather than the whole
        // time this page was up.
        this.#lastKeyDrawAt.clear()
    }

    async #renderKey(index: number): Promise<void> {
        const deck = this.#deck
        const tile = this.#mounted.get(index)
        if (!deck || !tile || this.#asleep) return
        try {
            await deck.fillKeyBuffer(index, this.#paintTile(tile, this.#keyDelta(index, this.#now())), FORMAT)
        } catch (error) {
            this.#logger.error('render failed', error)
        }
    }

    async #renderStrip(): Promise<void> {
        const deck = this.#deck
        if (!deck || this.#asleep) return
        try {
            await deck.fillLcd(0, this.#paintStrip(this.#stripDelta(this.#now())), FORMAT)
        } catch (error) {
            this.#logger.error('render failed', error)
        }
    }

    schedule(): void {
        if (this.#renderPending || this.#asleep) return
        this.#renderPending = true
        setTimeout(() => void this.render(), 50)
    }

    async render(): Promise<void> {
        this.#renderPending = false
        const deck = this.#deck
        if (!deck || this.#asleep) return
        try {
            const at = this.#now()
            const page = this.#currentPage()
            // The deck retains its last image, so blank slots must be painted too.
            for (let index = 0; index < 8; index += 1) {
                const tile = page ? tileAt(page.grid, index) : undefined
                await deck.fillKeyBuffer(index, this.#paintTile(tile, this.#keyDelta(index, at)), FORMAT)
            }

            await deck.fillLcd(0, this.#paintStrip(this.#stripDelta(at)), FORMAT)
        } catch (error) {
            this.#logger.error('render failed', error)
        }
    }

    #paintTile(tile: Tile | undefined, deltaTime: number): Buffer {
        this.#keySurface.reset()
        tile?.draw(this.#keySurface, deltaTime)
        return this.#keySurface.snapshot()
    }

    #paintStrip(deltaTime: number): Buffer {
        this.#stripSurface.reset()
        this.layout.strip.draw(this.#stripSurface, deltaTime)
        return this.#stripSurface.snapshot()
    }
}
