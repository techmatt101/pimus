import fs from 'node:fs'

import type { ControllerConfig } from './types.mjs'

export const DEFAULT_CONFIG_PATH = '/etc/smartamp/controller.json'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function validateControllerConfig(value: unknown, configPath: string): asserts value is ControllerConfig {
  if (!isRecord(value)) throw new Error(`Controller configuration at ${configPath} must be a JSON object`)

  if (value.voice_enabled) {
    if (typeof value.lva_uri !== 'string' || !/^wss?:\/\//i.test(value.lva_uri)) {
      throw new Error(`Controller configuration at ${configPath} must define a WebSocket lva_uri`)
    }
  }
  if (typeof value.audio_socket !== 'string' || value.audio_socket.length === 0) {
    throw new Error(`Controller configuration at ${configPath} must define audio_socket`)
  }

  if (isRecord(value.streamdeck) && value.streamdeck.enabled) {
    const deck = value.streamdeck
    if (!(Number(deck.brightness) >= 0 && Number(deck.brightness) <= 100)) {
      throw new Error(`Controller configuration at ${configPath} requires Stream Deck brightness from 0 to 100`)
    }
    if (!Array.isArray(deck.keys) || deck.keys.length > 8
        || !Array.isArray(deck.dials) || deck.dials.length > 4) {
      throw new Error(`Controller configuration at ${configPath} supports at most 8 keys and 4 dials`)
    }
  }

  if (isRecord(value.respeaker) && value.respeaker.enabled) {
    if (!isRecord(value.respeaker.states) || !isRecord(value.respeaker.states.idle)) {
      throw new Error(`Controller configuration at ${configPath} must define an idle ReSpeaker state`)
    }
  }

  if (isRecord(value.ducking) && value.ducking.enabled
      && (typeof value.ducking.state_file !== 'string'
        || !(Number(value.ducking.refresh_milliseconds) > 0))) {
    throw new Error(
      `Controller configuration at ${configPath} must define ducking state_file and refresh_milliseconds`,
    )
  }
}

export function loadConfig(
  path: string = process.env.SMARTAMP_CONFIG || DEFAULT_CONFIG_PATH,
): ControllerConfig {
  const config: unknown = JSON.parse(fs.readFileSync(path, 'utf8'))
  validateControllerConfig(config, path)
  return config
}
