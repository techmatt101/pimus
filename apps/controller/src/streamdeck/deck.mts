import {
  listStreamDecks,
  openStreamDeck,
  DeviceModelId,
  type StreamDeck,
  type StreamDeckDeviceInfo,
} from '@elgato-stream-deck/node'

import type { Binding } from './bindings.mjs'
import type { DeckRenderer } from './renderer.mjs'
import type { StreamDeckLayout } from './grid.mjs'

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

export function findStreamDeckPlus(devices: StreamDeckDeviceInfo[]): StreamDeckDeviceInfo | undefined {
  return devices.find((device) => device.model === DeviceModelId.PLUS)
}

export type Dispatch = (run: (() => unknown) | undefined) => Promise<unknown>

export function createDispatcher(logger: Pick<Console, 'error'> = console): Dispatch {
  let queue: Promise<unknown> = Promise.resolve()
  return (run) => {
    if (!run) return queue
    // Encoder rotation can produce many events in one tick. Chain every press
    // so route toggles and volume steps preserve their physical order.
    queue = queue
      .then(() => run())
      .catch((error: unknown) => logger.error('action failed', error))
    return queue
  }
}

export interface DeckLoopOptions {
  layout: StreamDeckLayout
  renderer: DeckRenderer
  /**
   * Report a key press, dial turn, or strip tap before it is acted on, so a
   * sleeping panel can wake (streamdeck/sleep.mts). Returning true means the
   * input was spent waking the deck and must not also run what it landed on.
   */
  onActivity?: () => boolean
  listDevices?: () => Promise<StreamDeckDeviceInfo[]>
  openDevice?: (path: string) => Promise<StreamDeck>
  retryMilliseconds?: number
  logger?: Pick<Console, 'log' | 'error'>
}

/** Owns the Stream Deck lifecycle: connect, bind input, reconnect on loss. */
export async function runDeckLoop({
  layout,
  renderer,
  onActivity,
  listDevices = listStreamDecks,
  openDevice = openStreamDeck,
  retryMilliseconds = 3000,
  logger = console,
}: DeckLoopOptions): Promise<never> {
  let deck: StreamDeck | null = null
  const dispatch = createDispatcher(logger)
  const pressBinding = (binding: Binding | undefined): void => {
    if (binding) void dispatch(() => binding.run())
  }
  /** True when this input only woke the panel, so nothing else should run. */
  const consumedByWake = (): boolean => onActivity?.() === true

  while (true) {
    try {
      const devices = await listDevices()
      const device = findStreamDeckPlus(devices)
      if (!device) {
        await sleep(retryMilliseconds)
        continue
      }

      deck = await openDevice(device.path)
      logger.log(`opened ${deck.PRODUCT_NAME}`)
      // The renderer owns everything written to the panel, brightness included:
      // a deck that reconnects while the room is empty comes back up dark.
      await renderer.setDeck(deck)

      // A USB unplug can emit several errors; without a listener still
      // attached after the first one, EventEmitter would throw and kill the
      // daemon instead of letting the loop reconnect.
      deck.on('error', () => {})
      const disconnected = new Promise<void>((resolve) => deck?.once('error', () => resolve()))
      deck.on('down', (controlDefinition) => {
        // The first press on a dark panel is you asking to see it, so it wakes
        // the deck and stops there rather than toggling something unreadable.
        if (consumedByWake()) return
        if (controlDefinition.type === 'button') {
          // Every key presses its current page's tile; paging moved to the
          // page-switcher dial (streamdeck/dials/page-dial.mts).
          void dispatch(renderer.pressAt(controlDefinition.index))
        } else if (controlDefinition.type === 'encoder') {
          // Touching a dial also puts it on the strip, so the value being
          // changed is visible while the hand is still on the knob.
          renderer.showDial(controlDefinition.index)
          pressBinding(layout.dials[controlDefinition.index]?.press)
        }
      })
      deck.on('rotate', (controlDefinition, amount) => {
        if (consumedByWake()) return
        renderer.showDial(controlDefinition.index)
        const dial = layout.dials[controlDefinition.index]
        const selected = amount < 0 ? dial?.left : dial?.right
        for (let count = 0; count < Math.min(10, Math.abs(amount)); count += 1) pressBinding(selected)
      })
      deck.on('lcdShortPress', (_controlDefinition, position) => {
        if (consumedByWake()) return
        // The strip decides what a tap means: acknowledging a notification if
        // one is showing, otherwise pressing the dial in that zone.
        void dispatch(renderer.stripPressAt(position.x))
      })
      await disconnected
    } catch (error) {
      logger.error('Stream Deck unavailable', error)
    } finally {
      renderer.clearDeck(deck)
      try { await deck?.close() } catch {}
      deck = null
    }
    await sleep(retryMilliseconds)
  }
}
