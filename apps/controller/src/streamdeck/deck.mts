import {
    DeviceModelId,
    listStreamDecks,
    openStreamDeck,
    type StreamDeck,
    type StreamDeckDeviceInfo,
} from '@elgato-stream-deck/node'

import type {Binding} from './bindings.mjs'
import type {DeckRenderer} from './renderer.mjs'
import type {StreamDeckLayout} from './grid.mjs'

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
        // Encoder rotation can produce many events in one tick; chaining keeps
        // route toggles and volume steps in their physical order.
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
     * Report input before it is acted on, so a sleeping panel can wake.
     * Returning true means the input was spent waking the deck and must not
     * also run what it landed on.
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
            await renderer.setDeck(deck)

            // A USB unplug can emit several errors; without a listener still
            // attached after the first one, EventEmitter would throw and kill
            // the daemon instead of letting the loop reconnect.
            deck.on('error', () => {
            })
            const disconnected = new Promise<void>((resolve) => deck?.once('error', () => resolve()))
            deck.on('down', (controlDefinition) => {
                if (consumedByWake()) return
                if (controlDefinition.type === 'button') {
                    void dispatch(renderer.pressAt(controlDefinition.index))
                } else if (controlDefinition.type === 'encoder') {
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
                void dispatch(renderer.stripPressAt(position.x))
            })
            await disconnected
        } catch (error) {
            logger.error('Stream Deck unavailable', error)
        } finally {
            renderer.clearDeck(deck)
            try {
                await deck?.close()
            } catch {
            }
            deck = null
        }
        await sleep(retryMilliseconds)
    }
}
