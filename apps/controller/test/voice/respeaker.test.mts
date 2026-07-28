import assert from 'node:assert/strict'
import test from 'node:test'

import {Leds} from '../../src/voice/led-appearance.mjs'
import {ReSpeakerController} from '../../src/voice/respeaker.mjs'
import type {LedFrame, ReSpeakerConfig, VoiceSensing} from '../../src/types.mjs'
import {LED_COUNT, LedEffect} from '../../src/types.mjs'

const CONFIG: ReSpeakerConfig = {
    enabled: true,
    vendor_id: 0x2886,
    product_id: 0x001a,
    brightness: 64,
}

/** Lets the microphone sensor's own poll deliver before the ring is read. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60))

const lightness = (ring: readonly number[] | undefined, index: number): number => {
    const color = ring?.[index] ?? 0
    return ((color >> 16) & 0xFF) + ((color >> 8) & 0xFF) + (color & 0xFF)
}

// The appearances asserted here come from the compiled state map in
// voice/led-states.mts.
test('ReSpeaker LEDs follow voice and mute state and ignore media playback', async () => {
    const rendered: LedFrame[] = []
    const controller = new ReSpeakerController({
        config: CONFIG,
        device: {
            apply: async (frame) => {
                rendered.push(frame)
            },
        },
    })

    await controller.handleEvent({event: 'snapshot', data: {ha_connected: true, muted: false}})
    await controller.handleEvent({event: 'listening'})
    // Listening paints the ring itself, from the microphone array's own level
    // and direction, rather than handing the firmware a direction effect.
    assert.equal(rendered.at(-1)?.effect, LedEffect.Ring)
    assert.equal(rendered.at(-1)?.ring?.length, LED_COUNT)

    // Media playback has no entry in the state map: music starting must not
    // repaint the ring away from the voice state it is showing.
    await controller.handleEvent({event: 'media_player_playing'})
    assert.equal(rendered.at(-1)?.effect, LedEffect.Ring)

    await controller.handleEvent({event: 'idle'})
    assert.deepEqual(rendered.at(-1),
        {effect: LedEffect.Off, brightness: 64, speed: 2, color: 0})

    // Mute overrides whatever voice state is active until it is lifted.
    await controller.handleEvent({event: 'muted', data: {muted: true}})
    assert.equal(rendered.at(-1)?.color, 0xd50000)
    await controller.handleEvent({event: 'muted', data: {muted: false}})
    assert.equal(rendered.at(-1)?.effect, LedEffect.Off)
})

test('the ring rides the microphone array while listening and the assistant while speaking', async () => {
    const rendered: LedFrame[] = []
    const metering: boolean[] = []
    let sensing: VoiceSensing = {direction: 0, energy: 1}
    let speech = 0
    const controller = new ReSpeakerController({
        config: CONFIG,
        // A pinned clock fixes the wave's phase, so the crest sits on the LED
        // facing the speaker rather than wherever it had travelled to.
        now: () => 0,
        device: {
            apply: async (frame) => {
                rendered.push(frame)
            },
        },
        sensor: {sense: async () => sensing},
        speechLevel: () => speech,
        onSpeechMeter: (active) => metering.push(active),
    })

    await controller.handleEvent({event: 'snapshot', data: {ha_connected: true, muted: false}})
    await controller.handleEvent({event: 'listening'})
    await settle()
    await controller.render()

    const facing = rendered.at(-1)?.ring
    assert.ok(facing, 'listening paints a ring')
    assert.ok(lightness(facing, 0) > lightness(facing, LED_COUNT / 2),
        'the wave leaves the LEDs facing the speaker brighter than those behind the array')

    // Nobody is speaking to it, so listening asks for no voice metering.
    assert.deepEqual(metering, [])

    sensing = {direction: Math.PI, energy: 1}
    await settle()
    await controller.render()
    const turned = rendered.at(-1)?.ring
    assert.ok(turned, 'the ring is still painted')
    assert.ok(lightness(turned, LED_COUNT / 2) > lightness(turned, 0),
        'the wave follows the speaker to the far side of the ring')

    // Speaking is metered by the audio manager, and only while it is showing.
    speech = 1
    await controller.handleEvent({event: 'tts_speaking'})
    assert.deepEqual(metering, [true])
    const loud = rendered.at(-1)?.ring
    assert.ok(loud, 'speaking paints a ring')

    speech = 0
    await controller.render()
    const quiet = rendered.at(-1)?.ring
    assert.ok(quiet, 'the ring is still painted')
    assert.ok(lightness(loud, 0) > lightness(quiet, 0),
        'the ring swells with the level the audio manager reports')

    await controller.handleEvent({event: 'tts_finished'})
    assert.deepEqual(metering, [true, false])
})

test('the ring shows boot until the voice socket answers, then reports a real loss', async () => {
    const rendered: LedFrame[] = []
    const controller = new ReSpeakerController({
        config: CONFIG,
        device: {
            apply: async (frame) => {
                rendered.push(frame)
            },
        },
    })

    // The controller now paints long before the voice assistant finishes its own
    // wait, so a first connection that has not happened is a wait, not a loss.
    assert.deepEqual(controller.desired(), Leds.spin('#ffd500'))
    controller.start()
    await controller.setDisconnected()
    assert.deepEqual(controller.desired(), Leds.spin('#ffd500'))

    // Once the socket has spoken, boot is over and a drop is a genuine warning.
    await controller.handleEvent({event: 'snapshot', data: {ha_connected: true, muted: false}})
    assert.deepEqual(controller.desired(), Leds.off())
    await controller.setDisconnected()
    assert.deepEqual(controller.desired(), Leds.pulse('#d50000'))

    // Stopping darkens the ring rather than leaving a state showing.
    await controller.release()
    assert.equal(rendered.at(-1)?.effect, LedEffect.Off)
})

test('LED-only mode does not force a disconnected warning', () => {
    const controller = new ReSpeakerController({
        voiceEnabled: false,
        config: CONFIG,
        device: {
            apply: async () => {
            }
        },
    })

    assert.deepEqual(controller.desired(), Leds.off())
})

test('ReSpeaker USB failures are retried without flooding the journal', async () => {
    let now = 0
    const warnings: unknown[][] = []
    const controller = new ReSpeakerController({
        now: () => now,
        warningIntervalMilliseconds: 30_000,
        logger: {
            warn: (...args: unknown[]) => {
                warnings.push(args)
            }
        },
        config: CONFIG,
        device: {
            apply: async () => {
                throw new Error('not connected')
            }
        },
    })

    await controller.render()
    now = 500
    await controller.render()
    now = 30_000
    await controller.render()
    assert.equal(warnings.length, 2)
})
