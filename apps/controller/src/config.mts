import fs from 'node:fs'

import type { ControllerConfig } from './types.mjs'

export const DEFAULT_CONFIG_PATH = '/etc/smartamp/controller.json'

export function loadConfig(
  path: string = process.env.SMARTAMP_CONFIG || DEFAULT_CONFIG_PATH,
): ControllerConfig {
  // Ansible generates this file from controller.json.j2, so the overall shape
  // is trusted. The checks below cover the fields whose absence would
  // otherwise surface much later as a confusing runtime failure.
  const config = JSON.parse(fs.readFileSync(path, 'utf8')) as ControllerConfig
  if (config.streamdeck?.enabled
      && (!Array.isArray(config.streamdeck.keys) || !Array.isArray(config.streamdeck.dials))) {
    throw new Error(`Controller configuration at ${path} must define Stream Deck keys and dials arrays`)
  }
  if (config.respeaker?.enabled && !config.respeaker.states?.idle) {
    throw new Error(`Controller configuration at ${path} must define an idle ReSpeaker state`)
  }
  if (config.ducking?.enabled
      && (typeof config.ducking.state_file !== 'string'
        || !(Number(config.ducking.refresh_milliseconds) > 0))) {
    throw new Error(
      `Controller configuration at ${path} must define ducking state_file and refresh_milliseconds`,
    )
  }
  return config
}
