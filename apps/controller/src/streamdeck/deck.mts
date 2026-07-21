import {
  listStreamDecks,
  openStreamDeck,
  DeviceModelId,
  type StreamDeck,
  type StreamDeckDeviceInfo,
} from '@elgato-stream-deck/node'

import type { DeckRenderer } from './renderer.mjs'
import type { StreamDeckLayout } from './grid.mjs'
import type { ActionHandler } from '../actions/handler.mjs'

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

export function findStreamDeckPlus(devices: StreamDeckDeviceInfo[]): StreamDeckDeviceInfo | undefined {
  return devices.find((device) => device.model === DeviceModelId.PLUS)
}

export function createActionDispatcher(
  handleAction: ActionHandler,
  logger: Pick<Console, 'error'> = console,
): (action: Parameters<ActionHandler>[0]) => Promise<void> {
  let queue = Promise.resolve()
  return (action) => {
    // Encoder rotation can produce many events in one tick. Chain every action
    // so route toggles and volume steps preserve their physical order.
    queue = queue
      .then(() => handleAction(action))
      .catch((error: unknown) => logger.error('action failed', error))
    return queue
  }
}

export interface DeckLoopOptions {
  layout: StreamDeckLayout
  renderer: DeckRenderer
  handleAction: ActionHandler
  listDevices?: () => Promise<StreamDeckDeviceInfo[]>
  openDevice?: (path: string) => Promise<StreamDeck>
  retryMilliseconds?: number
  logger?: Pick<Console, 'log' | 'error'>
}

/** Owns the Stream Deck lifecycle: connect, bind input, reconnect on loss. */
export async function runDeckLoop({
  layout,
  renderer,
  handleAction,
  listDevices = listStreamDecks,
  openDevice = openStreamDeck,
  retryMilliseconds = 3000,
  logger = console,
}: DeckLoopOptions): Promise<never> {
  let deck: StreamDeck | null = null
  const dispatch = createActionDispatcher(handleAction, logger)

  while (true) {
    try {
      const devices = await listDevices()
      const device = findStreamDeckPlus(devices)
      if (!device) {
        await sleep(retryMilliseconds)
        continue
      }

      deck = await openDevice(device.path)
      renderer.setDeck(deck)
      logger.log(`opened ${deck.PRODUCT_NAME}`)
      await deck.setBrightness(layout.brightness)
      await renderer.render()

      // A USB unplug can emit several errors; without a listener still
      // attached after the first one, EventEmitter would throw and kill the
      // daemon instead of letting the loop reconnect.
      deck.on('error', () => {})
      const disconnected = new Promise<void>((resolve) => deck?.once('error', () => resolve()))
      deck.on('down', (controlDefinition) => {
        if (controlDefinition.type === 'button') {
          // The bottom-corner keys page the grid when the layout has more than
          // one page; every other key dispatches its current page's action.
          const nav = renderer.navTarget(controlDefinition.index)
          if (nav) {
            renderer.changePage(nav === 'next' ? 1 : -1)
          } else {
            void dispatch(renderer.actionAt(controlDefinition.index))
          }
        } else if (controlDefinition.type === 'encoder') {
          void dispatch(layout.dials[controlDefinition.index]?.press)
        }
      })
      deck.on('rotate', (controlDefinition, amount) => {
        const dial = layout.dials[controlDefinition.index]
        const selected = amount < 0 ? dial?.left : dial?.right
        for (let count = 0; count < Math.min(10, Math.abs(amount)); count += 1) void dispatch(selected)
      })
      deck.on('lcdShortPress', (_controlDefinition, position) => {
        void dispatch(layout.dials[Math.min(3, Math.floor(position.x / 200))]?.press)
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
