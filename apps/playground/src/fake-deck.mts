// A Stream Deck+ that exists only in the browser. It implements the slice of
// the device API the controller actually drives, so the real deck lifecycle
// (streamdeck/deck.mts), renderer, paging, and tile mount/unmount all run
// unmodified — this only replaces the USB transport at the very bottom.

import { EventEmitter } from 'node:events'

import { DeviceModelId, type StreamDeck, type StreamDeckDeviceInfo } from '@elgato-stream-deck/node'

import { encodeRle, type PlaygroundBus } from './bus.mjs'

const KEY_COUNT = 8
const KEY_SIZE = 120
const LCD_WIDTH = 800
const LCD_HEIGHT = 100
/** Coalesces the eight per-key writes of one render into a single push. */
const FLUSH_MILLISECONDS = 20

export const DECK_GEOMETRY = { keyCount: KEY_COUNT, keySize: KEY_SIZE, lcdWidth: LCD_WIDTH, lcdHeight: LCD_HEIGHT }

/** The fake device handed to the deck loop, one per "plug in". */
class FakeStreamDeck extends EventEmitter {
  readonly PRODUCT_NAME = 'Stream Deck + (playground)'
  closed = false

  constructor(private readonly owner: FakeDeckHardware) {
    super()
  }

  async setBrightness(percent: number): Promise<void> {
    this.owner.setBrightness(percent)
  }

  async fillKeyBuffer(index: number, buffer: Buffer, _options?: unknown): Promise<void> {
    this.owner.writeKey(index, buffer)
  }

  async fillLcd(_x: number, buffer: Buffer, _options?: unknown): Promise<void> {
    this.owner.writeLcd(buffer)
  }

  async close(): Promise<void> {
    this.closed = true
    this.owner.detach(this)
  }
}

/**
 * The virtual hardware: device enumeration, the pixels the renderer last wrote,
 * and the input events the browser triggers. Unplugging is modelled the way a
 * real one behaves — an `error` on the open handle plus an empty device list —
 * so the reconnect loop is exercised rather than bypassed.
 */
export class FakeDeckHardware {
  brightness = 0
  attached = false

  private plugged = true
  private device: FakeStreamDeck | null = null
  private readonly keys = new Map<number, Buffer>()
  private lcd: Buffer | null = null
  private readonly dirty = new Set<number>()
  private lcdDirty = false
  private flushTimer: NodeJS.Timeout | null = null

  constructor(private readonly bus: PlaygroundBus) {}

  listDevices = async (): Promise<StreamDeckDeviceInfo[]> => (
    this.plugged
      ? [{ model: DeviceModelId.PLUS, path: 'playground://streamdeck-plus', serialNumber: 'PLAYGROUND' }]
      : []
  )

  openDevice = async (_path: string): Promise<StreamDeck> => {
    const device = new FakeStreamDeck(this)
    this.device = device
    this.attached = true
    this.bus.log('deck', 'note', 'deck attached')
    // The fake only supports the members the controller uses; the cast keeps
    // that boundary in one place instead of stubbing the whole device API.
    return device as unknown as StreamDeck
  }

  /** The panel's brightness, which is how a sleeping deck is seen going dark. */
  setBrightness(percent: number): void {
    if (this.brightness === percent) return
    this.brightness = percent
    this.bus.log('deck', 'out', percent === 0 ? 'panel off' : `panel brightness ${percent}`)
  }

  writeKey(index: number, buffer: Buffer): void {
    const previous = this.keys.get(index)
    if (previous && previous.equals(buffer)) return
    this.keys.set(index, Buffer.from(buffer))
    this.dirty.add(index)
    this.scheduleFlush()
  }

  writeLcd(buffer: Buffer): void {
    if (this.lcd && this.lcd.equals(buffer)) return
    this.lcd = Buffer.from(buffer)
    this.lcdDirty = true
    this.scheduleFlush()
  }

  detach(device: FakeStreamDeck): void {
    if (this.device !== device) return
    this.device = null
    this.attached = false
    this.keys.clear()
    this.lcd = null
    this.bus.clearFrame()
    this.bus.log('deck', 'note', 'deck detached')
  }

  // --- browser input -------------------------------------------------------

  pressKey(index: number): void {
    if (index < 0 || index >= KEY_COUNT) return
    this.bus.log('deck', 'in', `key ${index} pressed`)
    this.device?.emit('down', { type: 'button', index })
    this.device?.emit('up', { type: 'button', index })
  }

  pressDial(index: number): void {
    this.bus.log('deck', 'in', `dial ${index} pressed`)
    this.device?.emit('down', { type: 'encoder', index })
  }

  rotateDial(index: number, amount: number): void {
    this.bus.log('deck', 'in', `dial ${index} turned ${amount > 0 ? 'right' : 'left'}`)
    this.device?.emit('rotate', { type: 'encoder', index }, amount)
  }

  pressLcd(x: number): void {
    this.bus.log('deck', 'in', `touch strip pressed at x=${Math.round(x)}`)
    this.device?.emit('lcdShortPress', { type: 'lcd-segment', index: 0 }, { x, y: LCD_HEIGHT / 2 })
  }

  setPlugged(plugged: boolean): void {
    if (this.plugged === plugged) return
    this.plugged = plugged
    this.bus.log('deck', 'note', plugged ? 'deck plugged in' : 'deck unplugged')
    // A real unplug surfaces as an error on the open handle; the deck loop
    // listens for that to tear down and start reconnecting.
    if (!plugged) this.device?.emit('error', new Error('playground: device unplugged'))
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      const keys: Record<string, string> = {}
      for (const index of this.dirty) {
        const buffer = this.keys.get(index)
        if (buffer) keys[String(index)] = encodeRle(buffer)
      }
      this.dirty.clear()
      const lcd = this.lcdDirty && this.lcd ? encodeRle(this.lcd) : undefined
      this.lcdDirty = false
      this.bus.frame(keys, lcd)
    }, FLUSH_MILLISECONDS)
    this.flushTimer.unref()
  }
}
