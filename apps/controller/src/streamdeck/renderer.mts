import type {StreamDeck} from '@elgato-stream-deck/node'

import {DynamicDial} from './dials/dynamic-dial.mjs'
import {PageDial, type PageNavigator} from './dials/page-dial.mjs'
import {changedRegion, cropRegion} from './frame.mjs'
import {type StreamDeckLayout, type StreamDeckPage, tileAt,} from './grid.mjs'
import {STRIP_HEIGHT, STRIP_WIDTH} from './screens/screen.mjs'
import {Surface} from './surface.mjs'
import {KEY_SIZE, type Tile, type TileHost,} from './tile.mjs'
import type {ControlModel} from '../state.mjs'

const FORMAT = {format: 'rgba'} as const

// A dimmed panel is standby - the amp is suspended but somebody may well be
// in the room - so it has to stay readable rather than fade to something
// indistinguishable from off.
const DIM_FRACTION = 0.25

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
    readonly #dirtyKeys = new Set<number>()
    #stripDirty = false
    #allDirty = false
    #pump: Promise<void> | null = null
    #lastBrightness: number | null = null
    #pageIndex = 0
    readonly #mounted = new Map<number, Tile>()
    readonly #keySurface = new Surface(KEY_SIZE, KEY_SIZE)
    readonly #stripSurface = new Surface(STRIP_WIDTH, STRIP_HEIGHT)
    readonly #now: () => number = Date.now
    readonly #lastKeyDrawAt = new Map<number, number>()
    #lastStripDrawAt = 0
    // What the panel is already showing. A face that paints to the same pixels
    // needs no encode and no USB write at all.
    readonly #lastKeyFrame = new Map<number, Buffer>()
    #lastStripFrame: Buffer | null = null
    readonly #sharedDial: DynamicDial | null
    readonly #sharedDialIndex: number

    constructor({layout, model, logger = console}: DeckRendererOptions) {
        this.layout = layout
        this.#model = model
        this.#logger = logger
        this.#asleep = model.state.panel === 'off'
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
        this.#forgetFrames()
        this.#asleep = this.#model.state.panel === 'off'
        if (!this.#asleep) this.#mountVisible()
        await this.render()
        await this.#applyBrightness()
    }

    clearDeck(deck: StreamDeck | null): void {
        if (this.#deck !== deck) return
        this.#deck = null
        // A write abandoned by an unplug may never settle; drop the pump so the
        // next connection pumps afresh instead of awaiting it forever.
        this.#pump = null
        this.#forgetFrames()
        this.#unmountVisible()
    }

    // Hands the panel back on shutdown. Dropping the deck first stops a queued
    // repaint racing the reset and re-lighting a face nothing is driving.
    async releasePanel(): Promise<void> {
        const deck = this.#deck
        if (!deck) return
        this.#deck = null
        this.#forgetFrames()
        try {
            await deck.resetToLogo()
        } catch (error) {
            this.#logger.error('panel release failed', error)
        }
    }

    // Nothing is known about what a freshly opened panel is showing, so the next
    // pass must paint every face rather than trusting a previous connection's.
    #forgetFrames(): void {
        this.#lastKeyFrame.clear()
        this.#lastStripFrame = null
    }

    // The deck retains its last image, so waking must paint before raising the
    // brightness, and going dark must cut the brightness before dropping tiles.
    async #applyAwake(): Promise<void> {
        const asleep = this.#model.state.panel === 'off'
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
        this.layout.strip.mount({invalidate: () => this.#invalidateStrip()})
    }

    #unmountVisible(): void {
        this.#unmountPage()
        this.layout.strip.unmount()
    }

    async #applyBrightness(): Promise<void> {
        const deck = this.#deck
        if (!deck) return
        const target = this.#brightnessTarget()
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

    #brightnessTarget(): number {
        const {panel, brightness} = this.#model.state
        if (panel === 'off') return 0
        if (panel === 'dim') return Math.max(1, Math.round(brightness * DIM_FRACTION))
        return brightness
    }

    // Returns true when the touch was spent cancelling an active claim: reaching
    // for a different knob abandons the shared dial's claim, and that turn or
    // press does nothing else. The strip stays put so the escape reads as one.
    consumeClaimEscape(index: number): boolean {
        if (this.#sharedDial?.pinned() && index !== this.#sharedDialIndex) {
            this.#sharedDial.autoRelease()
            return true
        }
        return false
    }

    showDial(index: number): void {
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
        // While a key holds the shared dial, any other key's press is spent
        // cancelling that claim, not on its own action; the owner's press
        // through to confirm.
        if (this.#sharedDial?.pinned() && !(tile.holdsDial?.() ?? false)) {
            this.#sharedDial.autoRelease()
            return undefined
        }
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
            invalidate: () => this.#invalidateKey(index),
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

    #invalidateKey(index: number): void {
        this.#dirtyKeys.add(index)
        void this.#drain()
    }

    #invalidateStrip(): void {
        this.#stripDirty = true
        void this.#drain()
    }

    schedule(): void {
        if (this.#renderPending || this.#asleep) return
        this.#renderPending = true
        setTimeout(() => void this.render(), 50)
    }

    async render(): Promise<void> {
        this.#renderPending = false
        this.#allDirty = true
        await this.#drain()
    }

    // One write is in flight at a time: a repaint asked for mid-write marks its
    // surface dirty and is picked up by the same loop, so a burst of
    // invalidations collapses into one repaint instead of queueing USB writes.
    // The idle check must come before the pump is created: a loop that never
    // awaits settles synchronously, its cleanup runs before the assignment, and
    // the field would keep the settled promise forever — no paint ever again.
    // Entering with work guarantees at least one await, so cleanup runs late
    // enough; it must still guard against clobbering a successor pump.
    #drain(): Promise<void> {
        if (!this.#deck || this.#asleep || !this.#hasWork()) return this.#pump ?? Promise.resolve()
        if (this.#pump) return this.#pump
        const pump: Promise<void> = (async () => {
            while (this.#deck && !this.#asleep && this.#hasWork()) await this.#step()
        })().finally(() => {
            if (this.#pump === pump) this.#pump = null
        })
        this.#pump = pump
        return pump
    }

    #hasWork(): boolean {
        return this.#allDirty || this.#dirtyKeys.size > 0 || this.#stripDirty
    }

    async #step(): Promise<void> {
        if (this.#allDirty) {
            this.#allDirty = false
            this.#dirtyKeys.clear()
            this.#stripDirty = false
            await this.#writeAll()
            return
        }
        if (this.#stripDirty) {
            this.#stripDirty = false
            await this.#writeStrip()
            return
        }
        const next = this.#dirtyKeys.values().next()
        if (!next.done) {
            this.#dirtyKeys.delete(next.value)
            await this.#writeKey(next.value)
        }
    }

    async #writeAll(): Promise<void> {
        const at = this.#now()
        const page = this.#pageIndex
        // The strip goes first: it is what the user is watching mid-turn, and
        // writing it last would trail it behind eight key writes.
        await this.#writeStrip(at)
        // The deck retains its last image, so blank slots must be painted too.
        for (let index = 0; index < 8; index += 1) {
            // A page switch mid-pass re-marks everything; stop rather than
            // finish painting a mix of the two pages.
            if (this.#pageIndex !== page) return
            await this.#writeKey(index, at)
        }
    }

    async #writeKey(index: number, at = this.#now()): Promise<void> {
        const deck = this.#deck
        if (!deck || this.#asleep) return
        const page = this.#currentPage()
        const tile = page ? tileAt(page.grid, index) : undefined
        const frame = this.#paintTile(tile, this.#keyDelta(index, at))
        if (this.#lastKeyFrame.get(index)?.equals(frame)) return
        try {
            await deck.fillKeyBuffer(index, frame, FORMAT)
            this.#lastKeyFrame.set(index, frame)
        } catch (error) {
            this.#lastKeyFrame.delete(index)
            this.#logger.error('render failed', error)
        }
    }

    async #writeStrip(at = this.#now()): Promise<void> {
        const deck = this.#deck
        if (!deck || this.#asleep) return
        const frame = this.#paintStrip(this.#stripDelta(at))
        const previous = this.#lastStripFrame
        if (previous?.equals(frame)) return
        // A scrolling line or a flashing icon moves a band of the strip, so only
        // that band is encoded and sent; the panel retains the rest.
        const region = previous ? changedRegion(previous, frame, STRIP_WIDTH, STRIP_HEIGHT) : null
        try {
            if (region) {
                await deck.fillLcdRegion(0, region.x, region.y, cropRegion(frame, STRIP_WIDTH, region), {
                    ...FORMAT,
                    width: region.width,
                    height: region.height,
                })
            } else {
                await deck.fillLcd(0, frame, FORMAT)
            }
            this.#lastStripFrame = frame
        } catch (error) {
            this.#lastStripFrame = null
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
