import {
  listStreamDecks,
  openStreamDeck,
  type StreamDeck,
  type StreamDeckDeviceInfo,
} from '@elgato-stream-deck/node'

import type { DeckRenderer } from './display.mjs'
import type { ActionHandler } from './actions.mjs'
import type { StreamDeckConfig } from './types.mjs'

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

export interface DeckLoopOptions {
  config: StreamDeckConfig
  renderer: DeckRenderer
  handleAction: ActionHandler
  listDevices?: () => Promise<StreamDeckDeviceInfo[]>
  openDevice?: (path: string) => Promise<StreamDeck>
  retryMilliseconds?: number
  logger?: Pick<Console, 'log' | 'error'>
}

/** Owns the Stream Deck lifecycle: connect, bind input, reconnect on loss. */
export async function runDeckLoop({
  config,
  renderer,
  handleAction,
  listDevices = listStreamDecks,
  openDevice = openStreamDeck,
  retryMilliseconds = 3000,
  logger = console,
}: DeckLoopOptions): Promise<never> {
  let deck: StreamDeck | null = null
  const dispatch = (action: Parameters<ActionHandler>[0]): void => {
    Promise.resolve(handleAction(action)).catch((error: unknown) => logger.error('action failed', error))
  }

  while (true) {
    try {
      const devices = await listDevices()
      const device = devices[0]
      if (!device) {
        await sleep(retryMilliseconds)
        continue
      }

      deck = await openDevice(device.path)
      renderer.setDeck(deck)
      logger.log(`opened ${deck.PRODUCT_NAME}`)
      await deck.setBrightness(config.brightness)
      await renderer.render()

      // A USB unplug can emit several errors; without a listener still
      // attached after the first one, EventEmitter would throw and kill the
      // daemon instead of letting the loop reconnect.
      deck.on('error', () => {})
      const disconnected = new Promise<void>((resolve) => deck?.once('error', () => resolve()))
      deck.on('down', (controlDefinition) => {
        if (controlDefinition.type === 'button') {
          dispatch(config.keys[controlDefinition.index]?.action)
        } else if (controlDefinition.type === 'encoder') {
          dispatch(config.dials[controlDefinition.index]?.press)
        }
      })
      deck.on('rotate', (controlDefinition, amount) => {
        const dial = config.dials[controlDefinition.index]
        const selected = amount < 0 ? dial?.left : dial?.right
        for (let count = 0; count < Math.min(10, Math.abs(amount)); count += 1) dispatch(selected)
      })
      deck.on('lcdShortPress', (_controlDefinition, position) => {
        dispatch(config.dials[Math.min(3, Math.floor(position.x / 200))]?.press)
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
