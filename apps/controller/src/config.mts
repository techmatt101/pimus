import fs from 'node:fs'

import { describeActionProblem } from './actions/catalog.mjs'
import type { ControllerConfig } from './types.mjs'

export const DEFAULT_CONFIG_PATH = '/etc/smartamp/controller.json'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Checks every action bound to a key or dial against actions/catalog.mts. A
 * mistyped command would otherwise produce a key that looks configured but
 * does nothing when pressed, which is hard to diagnose on the device itself.
 */
function validateControls(deck: Record<string, unknown>, configPath: string): void {
  const problems: string[] = []
  const check = (action: unknown, where: string): void => {
    const problem = describeActionProblem(action)
    if (problem) problems.push(`${where}: ${problem}`)
  }

  const keys = Array.isArray(deck.keys) ? deck.keys : []
  keys.forEach((key: unknown, index) => {
    if (isRecord(key)) check(key.action, `key ${index} (${String(key.label ?? 'unlabelled')})`)
  })

  const dials = Array.isArray(deck.dials) ? deck.dials : []
  dials.forEach((dial: unknown, index) => {
    if (!isRecord(dial)) return
    const label = String(dial.label ?? 'unlabelled')
    for (const binding of ['left', 'right', 'press'] as const) {
      check(dial[binding], `dial ${index} (${label}) ${binding}`)
    }
  })

  if (problems.length > 0) {
    throw new Error(
      `Controller configuration at ${configPath} has invalid Stream Deck actions:\n  ${problems.join('\n  ')}`,
    )
  }
}

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
    validateControls(deck, configPath)
  }

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
