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

const BASE = {
  voice_enabled: false,
  audio_socket: '/run/smartamp/audio.sock',
  ducking: { enabled: false },
  streamdeck: { enabled: true },
  respeaker: { enabled: false },
}

test('an enabled remote-tile block must carry a port, and a token from the environment', (context) => {
  const configFile = writeConfig(context, { ...BASE, remote: { enabled: true, port: 8470 } })
  // Provisioning writes no token into controller.json, so an enabled listener
  // with nothing in the secrets file must fail by name rather than start open.
  assert.throws(() => loadConfig(configFile, {}), /REMOTE_TILES_TOKEN/)
  assert.equal(loadConfig(configFile, { REMOTE_TILES_TOKEN: 'secret' }).remote?.token, 'secret')

  const badPort = writeConfig(context, { ...BASE, remote: { enabled: true, port: 'high' } })
  assert.throws(() => loadConfig(badPort, { REMOTE_TILES_TOKEN: 'secret' }), /remote\.port/)

  // Disabled is the shipped default and needs neither; an unauthenticated
  // listener must be impossible to configure, not merely discouraged.
  const disabled = writeConfig(context, { ...BASE, remote: { enabled: false, port: 0 } })
  assert.equal(loadConfig(disabled, {}).remote?.enabled, false)
})

test('an enabled Home Assistant block takes its token from the environment', (context) => {
  const configFile = writeConfig(context, {
    ...BASE,
    home_assistant: { enabled: true, url: 'http://home-assistant.local:8123' },
  })
  assert.throws(() => loadConfig(configFile, {}), /HOME_ASSISTANT_TOKEN/)
  assert.equal(loadConfig(configFile, { HOME_ASSISTANT_TOKEN: 'lltoken' }).home_assistant?.token, 'lltoken')
})

test('a token left in controller.json never wins over the secrets file', (context) => {
  // The two would otherwise disagree silently after a token rotation, with the
  // stale JSON copy deciding which one the controller actually authenticates with.
  const configFile = writeConfig(context, {
    ...BASE,
    home_assistant: { enabled: true, url: 'http://home-assistant.local:8123', token: 'stale' },
  })
  assert.equal(loadConfig(configFile, { HOME_ASSISTANT_TOKEN: 'current' }).home_assistant?.token, 'current')
  assert.throws(() => loadConfig(configFile, {}), /HOME_ASSISTANT_TOKEN/)
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
