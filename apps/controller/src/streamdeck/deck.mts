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
import {logger as componentLogger} from '../log.mjs'

const log = componentLogger('deck')

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
                log.debug('down', controlDefinition.type, controlDefinition.index)
                if (consumedByWake()) return
                if (controlDefinition.type === 'button') {
                    void dispatch(renderer.pressAt(controlDefinition.index))
                } else if (controlDefinition.type === 'encoder') {
                    // A press that cancelled an active claim on another knob does nothing else.
                    if (renderer.consumeClaimEscape(controlDefinition.index)) return
                    pressBinding(layout.dials[controlDefinition.index]?.press)
                    // Queued after the press, so the dial face reads the value it left.
                    void dispatch(() => renderer.showDial(controlDefinition.index))
                }
            })
            deck.on('rotate', (controlDefinition, amount) => {
                log.debug('rotate', controlDefinition.index, amount)
                if (consumedByWake()) return
                // A turn that cancelled an active claim on another knob does not also step.
                if (renderer.consumeClaimEscape(controlDefinition.index)) return
                const dial = layout.dials[controlDefinition.index]
                const selected = amount < 0 ? dial?.left : dial?.right
                for (let count = 0; count < Math.min(10, Math.abs(amount)); count += 1) pressBinding(selected)
                // Queued after the steps, so the dial face reads the value they left.
                void dispatch(() => renderer.showDial(controlDefinition.index))
            })
            deck.on('lcdShortPress', (_controlDefinition, position) => {
                log.debug('strip tap', position.x)
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
