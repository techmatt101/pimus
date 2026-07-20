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

test('an idle ReSpeaker state is required when the LEDs are enabled', (context) => {
  const configFile = writeConfig(context, {
    voice_enabled: false,
    audio_socket: '/run/smartamp/audio.sock',
    ducking: { enabled: false },
    streamdeck: { enabled: false },
    respeaker: { enabled: true },
  })
  assert.throws(() => loadConfig(configFile), /must define an idle ReSpeaker state/)
})

test('a minimal deployment config loads, layout is compiled in separately', (context) => {
  const configFile = writeConfig(context, {
    voice_enabled: false,
    audio_socket: '/run/smartamp/audio.sock',
    ducking: { enabled: false },
    streamdeck: { enabled: true },
    respeaker: { enabled: false },
  })
  assert.equal(loadConfig(configFile).streamdeck?.enabled, true)
})
