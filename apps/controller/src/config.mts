import fs from 'node:fs'

import type { ControllerConfig } from './types.mjs'

export const DEFAULT_CONFIG_PATH = '/etc/smartamp/controller.json'
const HEX_COLOR = /^#[0-9a-f]{6}$/i
const ACTION_TYPES = new Set(['noop', 'lva', 'audio', 'led', 'webhook'])
const SOURCE_COMMANDS = new Set(['on', 'off', 'toggle'])
const VOLUME_COMMANDS = new Set(['up', 'down', 'mute'])
const LED_COMMANDS = new Set(['cycle', 'voice', 'off', 'single', 'breath', 'rainbow', 'doa', 'ring'])
const LED_EFFECTS = new Set(['off', 'breath', 'rainbow', 'single', 'doa', 'ring'])
const LVA_COMMANDS = new Set([
  'start_listening', 'stop_pipeline',
  'mute_mic', 'unmute_mic', 'mute_toggle',
  'volume_up', 'volume_down',
  'stop_timer_ringing',
  'pause_media_player', 'resume_media_player', 'stop_media_player', 'media_toggle',
  'button_single_press', 'button_double_press', 'button_triple_press', 'button_long_press',
  'stop',
])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function validateAction(value: unknown, location: string, webhookBase: unknown): void {
  if (value === undefined) return
  if (!isRecord(value) || typeof value.type !== 'string' || !ACTION_TYPES.has(value.type)) {
    throw new Error(`${location} must be a supported action object`)
  }
  if (value.type === 'noop') return
  if (value.type === 'webhook') {
    if (typeof value.id !== 'string' || value.id.length === 0) {
      throw new Error(`${location} webhook action must define an id`)
    }
    if (typeof webhookBase !== 'string' || !/^https?:\/\//i.test(webhookBase)) {
      throw new Error(`${location} webhook action requires an HTTP(S) webhook_base`)
    }
    return
  }
  if (typeof value.command !== 'string' || value.command.length === 0) {
    throw new Error(`${location} must define a command`)
  }
  if (value.type === 'audio') {
    if (value.source !== undefined && !['aux', 'usb'].includes(String(value.source))) {
      throw new Error(`${location} has an unsupported audio source`)
    }
    const commands = value.source === undefined ? VOLUME_COMMANDS : SOURCE_COMMANDS
    if (!commands.has(value.command)) throw new Error(`${location} has an invalid audio command`)
  } else if (value.type === 'led' && !LED_COMMANDS.has(value.command)) {
    throw new Error(`${location} has an invalid LED command`)
  } else if (value.type === 'lva' && !LVA_COMMANDS.has(value.command)) {
    throw new Error(`${location} has an invalid LVA command`)
  }
}

function validateControllerConfig(value: unknown, configPath: string): asserts value is ControllerConfig {
  if (!isRecord(value)) throw new Error(`Controller configuration at ${configPath} must be a JSON object`)

  if (value.voice_enabled) {
    if (typeof value.lva_uri !== 'string' || !/^wss?:\/\//i.test(value.lva_uri)) {
      throw new Error(`Controller configuration at ${configPath} must define a WebSocket lva_uri`)
    }
  }
  if (typeof value.audio_state_file !== 'string' || value.audio_state_file.length === 0) {
    throw new Error(`Controller configuration at ${configPath} must define audio_state_file`)
  }

  if (isRecord(value.streamdeck) && value.streamdeck.enabled) {
    const deck = value.streamdeck
    if (!Number.isInteger(deck.brightness) || Number(deck.brightness) < 0 || Number(deck.brightness) > 100) {
      throw new Error(`Controller configuration at ${configPath} requires Stream Deck brightness from 0 to 100`)
    }
    if (!Array.isArray(deck.keys) || deck.keys.length > 8
        || !Array.isArray(deck.dials) || deck.dials.length > 4) {
      throw new Error(`Controller configuration at ${configPath} supports at most 8 keys and 4 dials`)
    }
    deck.keys.forEach((key, index) => {
      if (!isRecord(key) || typeof key.label !== 'string'
          || typeof key.color !== 'string' || !HEX_COLOR.test(key.color)) {
        throw new Error(`Stream Deck key ${index + 1} must define a label and #RRGGBB color`)
      }
      validateAction(key.action, `Stream Deck key ${index + 1}`, value.webhook_base)
    })
    deck.dials.forEach((dial, index) => {
      if (!isRecord(dial) || typeof dial.label !== 'string') {
        throw new Error(`Stream Deck dial ${index + 1} must define a label`)
      }
      for (const gesture of ['left', 'right', 'press'] as const) {
        validateAction(dial[gesture], `Stream Deck dial ${index + 1} ${gesture}`, value.webhook_base)
      }
    })
  }

  if (isRecord(value.respeaker) && value.respeaker.enabled) {
    const led = value.respeaker
    for (const [field, maximum] of [['vendor_id', 65535], ['product_id', 65535], ['brightness', 255], ['speed', 255]] as const) {
      if (!Number.isInteger(led[field]) || Number(led[field]) < 0 || Number(led[field]) > maximum) {
        throw new Error(`ReSpeaker ${field} must be an integer from 0 to ${maximum}`)
      }
    }
    if (typeof led.state_file !== 'string' || typeof led.light_name !== 'string'
        || typeof led.light_object_id !== 'string' || !/^[a-z0-9_]+$/.test(led.light_object_id)) {
      throw new Error('ReSpeaker state_file, light_name, and lowercase light_object_id are required')
    }
    if (!isRecord(led.states) || !isRecord(led.states.idle)) {
      throw new Error(`Controller configuration at ${configPath} must define an idle ReSpeaker state`)
    }
    for (const [name, state] of Object.entries(led.states)) {
      if (!isRecord(state) || typeof state.effect !== 'string' || !LED_EFFECTS.has(state.effect)) {
        throw new Error(`ReSpeaker state ${name} has an invalid effect`)
      }
      for (const color of ['color', 'accent'] as const) {
        if (state[color] !== undefined && (typeof state[color] !== 'string' || !HEX_COLOR.test(state[color]))) {
          throw new Error(`ReSpeaker state ${name} ${color} must be #RRGGBB`)
        }
      }
      if (state.brightness !== undefined
          && (!Number.isInteger(state.brightness) || Number(state.brightness) < 0 || Number(state.brightness) > 255)) {
        throw new Error(`ReSpeaker state ${name} brightness must be from 0 to 255`)
      }
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
