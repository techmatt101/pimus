import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createActionHandler } from '../src/actions.mjs'
import { color, createImage } from '../src/bitmap.mjs'
import { loadConfig } from '../src/config.mjs'
import { createActionDispatcher, findStreamDeckPlus } from '../src/deck-controller.mjs'
import { dialDetail, keyAppearance } from '../src/display.mjs'
import { duckingForEvent, VoiceDucker, writeDuckRequest } from '../src/ducking.mjs'
import { encodePayload, ReSpeakerController, rgb, Xvf3800Device } from '../src/respeaker.mjs'
import { applyLvaEvent, createState } from '../src/state.mjs'
import { parseOutputState, runSmartampctl } from '../src/system-control.mjs'
import type { ChildProcess, spawn } from 'node:child_process'
import type { StreamDeckDeviceInfo } from '@elgato-stream-deck/node'
import type { Action, LedLocalState, LedStateSpec, StreamDeckKey, UsbControlDevice } from '../src/types.mjs'

test('LVA snapshots and events update shared display state', () => {
  const state = createState()
  applyLvaEvent(state, { event: 'snapshot', data: { muted: true, volume: 0.42, ha_connected: true } })
  assert.deepEqual(state, {
    assist: 'IDLE',
    muted: true,
    volume: 0.42,
    outputMuted: false,
    media: false,
  })

  applyLvaEvent(state, { event: 'wake_word_detected' })
  assert.equal(state.assist, 'WAKE_WORD_DETECTED')
  applyLvaEvent(state, { event: 'media_player_playing' })
  assert.equal(state.media, true)
  applyLvaEvent(state, { event: 'media_player_paused' })
  assert.equal(state.media, false)
  applyLvaEvent(state, { event: 'volume_changed', data: { volume: 0.8 } })
  assert.equal(state.volume, 0.8)
  applyLvaEvent(state, { event: 'volume_changed' })
  assert.equal(state.volume, 0.8)
})

test('non-pipeline events leave the assist display state alone', () => {
  const state = createState({ assist: 'LISTENING' })
  applyLvaEvent(state, { event: 'light_command', data: { object_id: 'led_ring' } })
  applyLvaEvent(state, { event: 'zeroconf', data: { status: 'connected' } })
  assert.equal(state.assist, 'LISTENING')
  applyLvaEvent(state, { event: 'timer_ticking' })
  assert.equal(state.assist, 'TIMER_TICKING')
  state.assist = 'LISTENING'
  applyLvaEvent(state, { event: 'timer_updated' })
  assert.equal(state.assist, 'TIMER_TICKING')
})

test('enabled ducking requires a state file and positive refresh interval', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pimus-config-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const configFile = path.join(directory, 'controller.json')
  fs.writeFileSync(configFile, JSON.stringify({
    audio_state_file: '/state/audio.json',
    ducking: { enabled: true, refresh_milliseconds: 0 },
    streamdeck: { enabled: false },
    respeaker: { enabled: false },
  }))
  assert.throws(() => loadConfig(configFile), /ducking state_file and refresh_milliseconds/)
})

test('invalid device and action configuration fails at startup', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pimus-invalid-config-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const configFile = path.join(directory, 'controller.json')
  const base = {
    voice_enabled: false,
    audio_state_file: '/state/audio.json',
    ducking: { enabled: false },
    streamdeck: { enabled: true, brightness: 101, keys: [], dials: [] },
    respeaker: { enabled: false },
  }
  fs.writeFileSync(configFile, JSON.stringify(base))
  assert.throws(() => loadConfig(configFile), /brightness from 0 to 100/)

  fs.writeFileSync(configFile, JSON.stringify({
    ...base,
    streamdeck: {
      enabled: true,
      brightness: 40,
      keys: [{ label: 'AUX', color: 'purple', action: { type: 'audio', source: 'aux', command: 'toggle' } }],
      dials: [],
    },
  }))
  assert.throws(() => loadConfig(configFile), /#RRGGBB color/)

  fs.writeFileSync(configFile, JSON.stringify({
    ...base,
    streamdeck: {
      enabled: true,
      brightness: 40,
      keys: [{ label: 'AUX', color: '#123456', action: { type: 'audio', source: 'aux', command: 'up' } }],
      dials: [],
    },
  }))
  assert.throws(() => loadConfig(configFile), /invalid audio command/)
})

test('key and dial appearances reflect audio and voice state', () => {
  const state = createState({ muted: true, volume: 0.67, media: true })
  const audioKey: StreamDeckKey = {
    label: 'AUX',
    color: '#4a148c',
    action: { type: 'audio', source: 'aux' },
  }
  assert.deepEqual(keyAppearance(audioKey, state, { sources: { aux: true } }), {
    label: 'AUX ON',
    background: '#1b5e20',
  })

  const muteKey: StreamDeckKey = {
    label: 'MIC',
    color: '#000000',
    action: { type: 'lva', command: 'mute_toggle' },
  }
  assert.deepEqual(keyAppearance(muteKey, state), { label: 'MIC OFF', background: '#d50000' })

  const voiceKey: StreamDeckKey = {
    label: 'VOICE',
    color: '#006064',
    action: { type: 'lva', command: 'start_listening' },
  }
  const active = createState({ assist: 'WAKE_WORD_DETECTED' })
  assert.equal(keyAppearance(voiceKey, active).background, '#00b8d4')

  assert.equal(dialDetail(0, state), '67%')
  state.outputMuted = true
  assert.equal(dialDetail(0, state), 'MUTED')
  assert.equal(dialDetail(1, state, { sources: { aux: true } }, {
    label: 'AUX',
    press: { type: 'audio', source: 'aux', command: 'toggle' },
  }), 'ON')
  assert.equal(dialDetail(2, state, { sources: { usb: false } }, {
    label: 'USB',
    left: { type: 'audio', source: 'usb', command: 'off' },
  }), 'OFF')
})

test('Stream Deck actions are serialized and the Plus model is selected', async () => {
  const observed: string[] = []
  let active = 0
  let maximumActive = 0
  const dispatch = createActionDispatcher(async (action) => {
    active += 1
    maximumActive = Math.max(maximumActive, active)
    await new Promise((resolve) => setTimeout(resolve, 1))
    observed.push(action?.command ?? '')
    active -= 1
  })
  const actions: Action[] = [
    { type: 'audio', command: 'one' },
    { type: 'audio', command: 'two' },
    { type: 'audio', command: 'three' },
  ]
  await Promise.all(actions.map((action) => dispatch(action)))
  assert.equal(maximumActive, 1)
  assert.deepEqual(observed, ['one', 'two', 'three'])

  const devices = [
    { model: 'original', path: '/dev/hidraw0' },
    { model: 'plus', path: '/dev/hidraw1' },
  ] as StreamDeckDeviceInfo[]
  assert.equal(findStreamDeckPlus(devices)?.path, '/dev/hidraw1')
})

test('action handler routes device and LVA commands', async () => {
  const state = createState({ muted: false, media: true })
  const lvaCommands: string[] = []
  const controlCommands: string[][] = []
  const lightCommands: string[] = []
  let changes = 0
  const handle = createActionHandler({
    state,
    lva: { send: (command) => { lvaCommands.push(command) } },
    control: (args) => controlCommands.push(args),
    lights: (command) => lightCommands.push(command),
    onStateChange: () => { changes += 1 },
  })

  await handle({ type: 'lva', command: 'mute_toggle' })
  await handle({ type: 'lva', command: 'stop' })
  await handle({ type: 'audio', source: 'usb', command: 'toggle' })
  await handle({ type: 'led', command: 'cycle' })

  assert.deepEqual(lvaCommands, ['mute_mic', 'stop_timer_ringing', 'stop_pipeline', 'stop_media_player'])
  assert.deepEqual(controlCommands, [
    ['source', 'usb', 'toggle'],
  ])
  assert.deepEqual(lightCommands, ['cycle'])
  assert.equal(state.media, false)
  assert.equal(changes, 1)
})

test('webhook actions encode their identifier', async () => {
  const requests: unknown[][] = []
  const handle = createActionHandler({
    state: createState(),
    lva: { send: () => {} },
    control: () => {},
    lights: () => {},
    webhookBase: 'http://homeassistant.local:8123/api/webhook/',
    request: async (...args: unknown[]) => { requests.push(args) },
  })
  await handle({ type: 'webhook', id: 'movie mode' })
  assert.deepEqual(requests, [[
    'http://homeassistant.local:8123/api/webhook/movie%20mode',
    { method: 'POST' },
  ]])
})

test('bitmap and PipeWire parsers produce deterministic values', () => {
  assert.deepEqual(color('#102030'), [16, 32, 48])
  assert.deepEqual([...createImage(1, 1, '#010203').buffer], [1, 2, 3])
  assert.deepEqual(parseOutputState('Volume: 0.55 [MUTED]'), { volume: 0.55, outputMuted: true })
})

test('smartampctl process failures are logged and still refresh state', () => {
  const child = new EventEmitter() as ChildProcess
  const errors: unknown[][] = []
  let exits = 0
  runSmartampctl(['source', 'aux', 'toggle'], {
    spawnProcess: (() => child) as typeof spawn,
    onExit: () => { exits += 1 },
    logger: { error: (...args: unknown[]) => { errors.push(args) } },
  })
  child.emit('error', new Error('spawn failed'))
  child.emit('exit', 1, null)
  assert.equal(exits, 1)
  assert.equal(errors.length, 2)
  assert.match(String(errors[0]?.[0]), /failed to start/)
  assert.match(String(errors[1]?.[0]), /exited 1/)
})

test('voice pipeline events duck and safely restore background audio', () => {
  const writes: [string, boolean][] = []
  const ducker = new VoiceDucker({
    stateFile: '/runtime/duck.json',
    refreshMilliseconds: 0,
    writeRequest: (stateFile, active) => writes.push([stateFile, active]),
  })

  assert.equal(duckingForEvent({ event: 'wake_word_detected' }), true)
  assert.equal(duckingForEvent({ event: 'media_player_playing' }), null)
  assert.equal(duckingForEvent({ event: 'tts_finished' }), false)
  assert.equal(duckingForEvent({ event: 'snapshot' }), false)

  ducker.handleEvent({ event: 'listening' })
  ducker.handleEvent({ event: 'thinking' })
  ducker.handleEvent({ event: 'idle' })
  assert.deepEqual(writes, [
    ['/runtime/duck.json', true],
    ['/runtime/duck.json', true],
    ['/runtime/duck.json', false],
  ])
})

test('duck requests use atomic JSON with a cross-process timestamp', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pimus-ducking-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const stateFile = path.join(directory, 'duck.json')
  writeDuckRequest(stateFile, true, 2500)
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), {
    active: true,
    updated_at: 2.5,
  })
})

test('XVF3800 commands use vendor transfers and little-endian payloads', async () => {
  const transfers: unknown[][] = []
  const usbDevice: UsbControlDevice & { openCalls: number } = {
    openCalls: 0,
    timeout: 0,
    open() { this.openCalls += 1 },
    close() {},
    controlTransfer(...args: unknown[]) {
      const callback = args.pop() as (error: unknown) => void
      transfers.push(args)
      callback(null)
    },
  }
  const device = new Xvf3800Device({
    vendorId: 0x2886,
    productId: 0x001a,
    findDevice: () => usbDevice,
  })

  await device.apply({ effect: 'doa', color: '#102030', accent: '#a0b0c0' }, 64, 2)

  assert.equal(usbDevice.openCalls, 1)
  assert.deepEqual(transfers.map((entry) => entry.slice(0, 4)), [
    [0x40, 0, 13, 20],
    [0x40, 0, 15, 20],
    [0x40, 0, 16, 20],
    [0x40, 0, 17, 20],
    [0x40, 0, 12, 20],
  ])
  assert.deepEqual([...(transfers[3]?.[4] as Buffer)], [0x30, 0x20, 0x10, 0, 0xc0, 0xb0, 0xa0, 0])

  transfers.length = 0
  await device.apply({ effect: 'ring', color: '#010203' }, 32, 1)
  assert.deepEqual(transfers.map((entry) => entry.slice(0, 4)), [
    [0x40, 0, 13, 20],
    [0x40, 0, 15, 20],
    [0x40, 0, 16, 20],
    [0x40, 0, 19, 20],
    [0x40, 0, 12, 20],
  ])
  assert.deepEqual(
    [...(transfers[3]?.[4] as Buffer)],
    Array(12).fill([0x03, 0x02, 0x01, 0]).flat(),
  )
  assert.equal(rgb('#abcdef'), 0xabcdef)
  assert.deepEqual([...encodePayload('uint8', [-1, 256])], [0, 255])
})

test('ReSpeaker state follows voice events and Home Assistant light commands', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pimus-controller-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const stateFile = path.join(directory, 'led-state.json')
  const rendered: [LedStateSpec, number, number][] = []
  const controller = new ReSpeakerController({
    config: {
      enabled: true,
      vendor_id: 0x2886,
      product_id: 0x001a,
      state_file: stateFile,
      brightness: 64,
      speed: 2,
      light_name: 'Office Amp LED Ring',
      light_object_id: 'led_ring',
      states: {
        idle: { effect: 'doa', color: '#102030', accent: '#00bcd4' },
        listening: { effect: 'breath', color: '#00e5ff' },
        disconnected: { effect: 'single', color: '#d50000' },
      },
    },
    device: {
      apply: async (spec, brightness, speed) => { rendered.push([spec, brightness, speed]) },
    },
  })

  await controller.handleEvent({ event: 'snapshot', data: { ha_connected: true, muted: false } })
  await controller.handleEvent({ event: 'listening' })
  assert.deepEqual(rendered.at(-1), [{ effect: 'breath', color: '#00e5ff' }, 64, 2])

  await controller.handleEvent({
    event: 'light_command',
    data: {
      object_id: 'led_ring',
      effect: 'Rainbow',
      red: 1,
      green: 0.5,
      blue: 0,
      brightness: 0.25,
    },
  })
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), {
    mode: 'rainbow',
    color: '#ff8000',
    brightness: 64,
  })

  await controller.command('cycle')
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).mode, 'doa')

  // Unchanged state must not rewrite the file: pin the mtime into the past
  // and confirm an identical write leaves it alone while a real change moves it.
  const past = new Date('2020-01-01T00:00:00Z')
  const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as LedLocalState
  fs.utimesSync(stateFile, past, past)
  controller.writeLocal(persisted)
  assert.equal(fs.statSync(stateFile).mtimeMs, past.getTime())
  controller.writeLocal({ ...persisted, mode: 'off' })
  assert.notEqual(fs.statSync(stateFile).mtimeMs, past.getTime())
})

test('LED-only mode does not force a disconnected warning', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pimus-led-only-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const stateFile = path.join(directory, 'led-state.json')
  fs.writeFileSync(stateFile, JSON.stringify({ mode: 'single', color: '#123456' }))
  const controller = new ReSpeakerController({
    voiceEnabled: false,
    config: {
      enabled: true,
      vendor_id: 0x2886,
      product_id: 0x001a,
      state_file: stateFile,
      brightness: 64,
      speed: 2,
      light_name: 'Office Amp LED Ring',
      light_object_id: 'led_ring',
      states: {
        idle: { effect: 'doa', color: '#001018' },
        disconnected: { effect: 'breath', color: '#d50000' },
      },
    },
    device: { apply: async () => {} },
  })

  assert.deepEqual(controller.desired(), {
    effect: 'single',
    color: '#123456',
    accent: '#ffffff',
    brightness: 64,
  })
})

test('ReSpeaker USB failures are retried without flooding the journal', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pimus-led-warning-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let now = 0
  const warnings: unknown[][] = []
  const controller = new ReSpeakerController({
    now: () => now,
    warningIntervalMilliseconds: 30_000,
    logger: { warn: (...args: unknown[]) => { warnings.push(args) } },
    config: {
      enabled: true,
      vendor_id: 0x2886,
      product_id: 0x001a,
      state_file: path.join(directory, 'led-state.json'),
      brightness: 64,
      speed: 2,
      light_name: 'Office Amp LED Ring',
      light_object_id: 'led_ring',
      states: { idle: { effect: 'doa', color: '#001018' } },
    },
    device: { apply: async () => { throw new Error('not connected') } },
  })

  await controller.render(true)
  now = 500
  await controller.render(true)
  now = 30_000
  await controller.render(true)
  assert.equal(warnings.length, 2)
})
