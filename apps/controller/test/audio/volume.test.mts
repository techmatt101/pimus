import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import test from 'node:test'

import {parseOutputState, runVolumeCommand} from '../../src/audio/volume.mjs'
import {ControlModel, createState} from '../../src/state.mjs'
import {VolumeDial} from '../../src/streamdeck/dials/volume-dial.mjs'
import type {AudioControls} from '../../src/types.mjs'
import type {ChildProcess, spawn} from 'node:child_process'

test('volume commands run wpctl directly and log failures', () => {
    const spawned: [string, string[]][] = []
    const child = new EventEmitter() as ChildProcess
    const errors: unknown[][] = []
    let exits = 0
    runVolumeCommand('up', {
        spawnProcess: ((file: string, args: string[]) => {
            spawned.push([file, args])
            return child
        }) as unknown as typeof spawn,
        onExit: () => {
            exits += 1
        },
        logger: {
            error: (...args: unknown[]) => {
                errors.push(args)
            }
        },
    })
    assert.deepEqual(spawned, [['wpctl', ['set-volume', '-l', '1.0', '@DEFAULT_AUDIO_SINK@', '5%+']]])
    child.emit('error', new Error('spawn failed'))
    child.emit('exit', 1, null)
    assert.equal(exits, 1)
    assert.equal(errors.length, 2)
    assert.match(String(errors[0]?.[0]), /failed to start/)
    assert.match(String(errors[1]?.[0]), /exited 1/)

    assert.equal(runVolumeCommand('sideways', {
        spawnProcess: (() => child) as typeof spawn,
        logger: {
            error: () => {
            }
        },
    }), null)
})

test('PipeWire volume output parses into display state', () => {
    assert.deepEqual(parseOutputState('Volume: 0.55 [MUTED]'), {volume: 0.55, outputMuted: true})
    assert.deepEqual(parseOutputState('Volume: 1.00'), {volume: 1, outputMuted: false})
})

test('the volume dial steers music at rest and the voice bus while assist is live', () => {
    const calls: string[] = []
    let voicePercent: number | undefined = 60
    let musicPercent: number | undefined = 80
    const audio: AudioControls = {
        setVolume: (command) => calls.push(`music:${command}`),
        setSource: () => {
        },
        setVoiceVolume: (percent) => {
            voicePercent = percent
            calls.push(`voice:${percent}`)
        },
    }
    const state = createState()
    const model = new ControlModel(state, () => ({
        sources: {},
        musicVolume: musicPercent,
        voiceVolume: voicePercent,
    }))
    const dial = new VolumeDial(audio, model)

    assert.equal(dial.detail(), '80%')
    dial.right.run()
    assert.deepEqual(calls, ['music:up'])
    assert.equal(dial.label, 'VOLUME')

    // A speaking assistant hands the dial to the voice bus: detents move the
    // voice level and leave the music level where it is.
    state.assist = 'TTS_SPEAKING'
    assert.equal(dial.label, 'VOICE')
    assert.equal(dial.detail(), '60%')
    dial.left.run()
    assert.deepEqual(calls.slice(1), ['voice:55'])
    assert.equal(musicPercent, 80)

    state.assist = 'IDLE'
    dial.right.run()
    assert.deepEqual(calls.slice(2), ['music:up'])

    // With the audio manager unreachable the level is unknown: the readout
    // says so and a detent must not invent a value to send.
    voicePercent = undefined
    state.assist = 'TIMER_RINGING'
    assert.equal(dial.detail(), '?')
    dial.right.run()
    assert.deepEqual(calls.slice(2), ['music:up'])
})
