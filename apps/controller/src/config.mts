import fs from 'node:fs'

import type {ControllerConfig} from './types.mjs'

export const DEFAULT_CONFIG_PATH = '/etc/smartamp/controller.json'

/**
 * Tokens are deliberately absent from controller.json. They are hand-written on
 * the Pi in this file, which the systemd unit loads into the service
 * environment, so provisioning never carries a secret and never rewrites it.
 * Only the path is named here; the controller reads the values from its own
 * environment.
 */
export const SECRETS_PATH = '/etc/smartamp/secrets.env'

const HOME_ASSISTANT_TOKEN = 'HOME_ASSISTANT_TOKEN'
const REMOTE_TILES_TOKEN = 'REMOTE_TILES_TOKEN'

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Folds the tokens systemd loaded from the secrets file into the parsed
 * configuration. Doing it here means every module below sees one resolved
 * shape and none of them needs to know a secret arrived by a different route.
 */
function applySecrets(value: Record<string, unknown>, env: Record<string, string | undefined>): void {
    // Always overwrite, so a token pasted into controller.json by hand cannot
    // become a second, stale source for the one the secrets file is meant to own.
    if (isRecord(value.home_assistant)) value.home_assistant.token = env[HOME_ASSISTANT_TOKEN] ?? ''
    if (isRecord(value.remote)) value.remote.token = env[REMOTE_TILES_TOKEN] ?? ''
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

    // The Stream Deck layout is compiled in (streamdeck/layout.mts) and validated
    // by its own test, so only the enable flag needs checking here.

    // The Home Assistant tiles read state over the WebSocket API, which needs a
    // reachable base URL and a long-lived access token. Checking them here means
    // a half-filled deployment fails at startup with a clear message instead of
    // producing a deck of keys that quietly never connect.
    if (isRecord(value.home_assistant) && value.home_assistant.enabled) {
        const {url, token} = value.home_assistant
        if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
            throw new Error(`Controller configuration at ${configPath} must define an http(s) home_assistant.url`)
        }
        if (typeof token !== 'string' || token.length === 0) {
            throw new Error(
                `Home Assistant is enabled in ${configPath}, so ${SECRETS_PATH} must set a non-empty ${HOME_ASSISTANT_TOKEN}`,
            )
        }
    }

    // The remote-tile server is the controller's one inbound listener, so an
    // enabled block must carry a real port and a non-empty shared token; an
    // unauthenticated listener must be impossible to configure by accident.
    if (isRecord(value.remote) && value.remote.enabled) {
        const {port, token} = value.remote
        if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error(`Controller configuration at ${configPath} must define a TCP remote.port`)
        }
        if (typeof token !== 'string' || token.length === 0) {
            throw new Error(
                `The remote-tile server is enabled in ${configPath}, so ${SECRETS_PATH} must set a non-empty ${REMOTE_TILES_TOKEN}`,
            )
        }
    }
}

export function loadConfig(
    path: string = process.env.SMARTAMP_CONFIG || DEFAULT_CONFIG_PATH,
    env: Record<string, string | undefined> = process.env,
): ControllerConfig {
    const config: unknown = JSON.parse(fs.readFileSync(path, 'utf8'))
    if (isRecord(config)) applySecrets(config, env)
    validateControllerConfig(config, path)
    return config
}
