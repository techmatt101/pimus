import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createActionHandler } from '../src/actions.mjs'
import { color, createImage } from '../src/bitmap.mjs'
import { loadConfig } from '../src/config.mjs'
import { dialDetail, keyAppearance } from '../src/display.mjs'
import { duckingForEvent, VoiceDucker, writeDuckRequest } from '../src/ducking.mjs'
import { encodePayload, ReSpeakerController, rgb, Xvf3800Device } from '../src/respeaker.mjs'
import { applyLvaEvent, createState } from '../src/state.mjs'
import { parseOutputState } from '../src/system-control.mjs'

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
})

test('enabled ducking requires a state file and positive refresh interval', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pimus-config-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const configFile = path.join(directory, 'controller.json')
  fs.writeFileSync(configFile, JSON.stringify({
    ducking: { enabled: true, refresh_milliseconds: 0 },
    streamdeck: { enabled: false },
    respeaker: { enabled: false },
  }))
  assert.throws(() => loadConfig(configFile), /ducking state_file and refresh_milliseconds/)
})

test('key and dial appearances reflect audio and voice state', () => {
  const state = createState({ muted: true, volume: 0.67, media: true })
  const audioKey = { label: 'AUX', color: '#4a148c', action: { type: 'audio', source: 'aux' } }
  assert.deepEqual(keyAppearance(audioKey, state, { sources: { aux: true } }), {
    label: 'AUX ON',
    background: '#1b5e20',
  })

  const muteKey = { label: 'MIC', color: '#000000', action: { command: 'mute_toggle' } }
  assert.deepEqual(keyAppearance(muteKey, state), { label: 'MIC OFF', background: '#d50000' })
  assert.equal(dialDetail(0, state), '67%')
  state.outputMuted = true
  assert.equal(dialDetail(0, state), 'MUTED')
})

test('action handler routes device and LVA commands', async () => {
  const state = createState({ muted: false, media: true })
  const lvaCommands = []
  const controlCommands = []
  const lightCommands = []
  let changes = 0
  const handle = createActionHandler({
    state,
    lva: { send: (command) => lvaCommands.push(command) },
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
  const requests = []
  const handle = createActionHandler({
    state: createState(),
    lva: { send: () => {} },
    control: () => {},
    webhookBase: 'http://homeassistant.local:8123/api/webhook/',
    request: async (...args) => { requests.push(args) },
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

test('voice pipeline events duck and safely restore background audio', () => {
  const writes = []
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
  const transfers = []
  const usbDevice = {
    openCalls: 0,
    open() { this.openCalls += 1 },
    controlTransfer(...args) {
      const callback = args.pop()
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
  assert.deepEqual([...transfers[3][4]], [0x30, 0x20, 0x10, 0, 0xc0, 0xb0, 0xa0, 0])
  assert.equal(rgb('#abcdef'), 0xabcdef)
  assert.deepEqual([...encodePayload('uint8', [-1, 256])], [0, 255])
})

test('ReSpeaker state follows voice events and Home Assistant light commands', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pimus-controller-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const stateFile = path.join(directory, 'led-state.json')
  const rendered = []
  const controller = new ReSpeakerController({
    config: {
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
    device: { apply: async (...args) => rendered.push(args) },
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
})
