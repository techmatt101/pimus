import fs from 'node:fs'

export const DEFAULT_CONFIG_PATH = '/etc/smartamp/streamdeck.json'

export function loadConfig(path = process.env.SMARTAMP_CONFIG || DEFAULT_CONFIG_PATH) {
  const config = JSON.parse(fs.readFileSync(path, 'utf8'))
  if (!Array.isArray(config.keys) || !Array.isArray(config.dials)) {
    throw new Error(`Stream Deck configuration at ${path} must define keys and dials arrays`)
  }
  return config
}
