import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { loadConfig } from '../src/config.mjs'

/** Writes a controller.json into a scratch directory and returns its path. */
function writeConfig(context: { after(fn: () => void): void }, config: unknown): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pimus-config-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const configFile = path.join(directory, 'controller.json')
  fs.writeFileSync(configFile, JSON.stringify(config))
  return configFile
}

test('a controller socket is required, since it now carries duck requests too', (context) => {
  const configFile = writeConfig(context, {
    voice_enabled: false,
    ducking: { enabled: true },
    streamdeck: { enabled: false },
    respeaker: { enabled: false },
  })
  assert.throws(() => loadConfig(configFile), /must define audio_socket/)
})

test('invalid device configuration fails at startup', (context) => {
  const configFile = writeConfig(context, {
    voice_enabled: false,
    audio_socket: '/run/smartamp/audio.sock',
    ducking: { enabled: false },
    streamdeck: { enabled: true, brightness: 101, keys: [], dials: [] },
    respeaker: { enabled: false },
  })
  assert.throws(() => loadConfig(configFile), /brightness from 0 to 100/)
})

test('a mistyped Stream Deck action names the control that is wrong', (context) => {
  const configFile = writeConfig(context, {
    voice_enabled: false,
    audio_socket: '/run/smartamp/audio.sock',
    ducking: { enabled: false },
    streamdeck: {
      enabled: true,
      brightness: 40,
      keys: [{ label: 'AUX', color: '#4a148c', action: { type: 'audio', source: 'aux', command: 'flip' } }],
      dials: [{ label: 'VOLUME', press: { type: 'audio', command: 'sideways' } }],
    },
    respeaker: { enabled: false },
  })
  assert.throws(() => loadConfig(configFile), (error: Error) => {
    assert.match(error.message, /key 0 \(AUX\): unknown route command "flip"/)
    assert.match(error.message, /dial 0 \(VOLUME\) press: unknown volume command "sideways"/)
    return true
  })
})

test('the configured control surface loads cleanly', (context) => {
  const configFile = writeConfig(context, {
    voice_enabled: false,
    audio_socket: '/run/smartamp/audio.sock',
    ducking: { enabled: false },
    streamdeck: {
      enabled: true,
      brightness: 40,
      keys: [
        { label: 'VOICE', color: '#006064', action: { type: 'lva', command: 'start_listening' } },
        { label: 'AUX', color: '#4a148c', action: { type: 'audio', source: 'aux', command: 'toggle' } },
      ],
      dials: [{
        label: 'VOLUME',
        left: { type: 'audio', command: 'down' },
        right: { type: 'audio', command: 'up' },
        press: { type: 'audio', command: 'mute' },
      }],
    },
    respeaker: { enabled: false },
  })
  assert.equal(loadConfig(configFile).streamdeck?.keys.length, 2)
})
