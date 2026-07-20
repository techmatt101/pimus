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

  // The Stream Deck layout is compiled in (streamdeck/layout.mts) and validated
  // by its own test, so only the enable flag needs checking here.

  if (isRecord(value.respeaker) && value.respeaker.enabled) {
    if (!isRecord(value.respeaker.states) || !isRecord(value.respeaker.states.idle)) {
      throw new Error(`Controller configuration at ${configPath} must define an idle ReSpeaker state`)
    }
  }

}

export function loadConfig(
  path: string = process.env.SMARTAMP_CONFIG || DEFAULT_CONFIG_PATH,
): ControllerConfig {
  const config: unknown = JSON.parse(fs.readFileSync(path, 'utf8'))
  validateControllerConfig(config, path)
  return config
}
