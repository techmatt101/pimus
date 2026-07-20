import fs from 'node:fs'

export const DEFAULT_CONFIG_PATH = '/etc/smartamp/controller.json'

export function loadConfig(path = process.env.SMARTAMP_CONFIG || DEFAULT_CONFIG_PATH) {
  const config = JSON.parse(fs.readFileSync(path, 'utf8'))
  if (config.streamdeck?.enabled
      && (!Array.isArray(config.streamdeck.keys) || !Array.isArray(config.streamdeck.dials))) {
    throw new Error(`Controller configuration at ${path} must define Stream Deck keys and dials arrays`)
  }
  if (config.respeaker?.enabled && !config.respeaker.states?.idle) {
    throw new Error(`Controller configuration at ${path} must define an idle ReSpeaker state`)
  }
  return config
}
