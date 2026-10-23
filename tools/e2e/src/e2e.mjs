// The end-to-end run, driven from the control computer. For each amp in the
// inventory it runs the on-demand self-test on the Pi over SSH, then makes
// the checks only this computer can: playing a tone into the amp's USB-C
// sound card, firing the smartamp_notify event at Home Assistant, having the
// voice satellite announce, and streaming a file to the Sendspin player. For
// each of those the Pi is asked to observe (smartamp-selftest observe ...)
// while this side stimulates, and the observation is judged here.
//
//   node tools/e2e/src/e2e.mjs [--limit office-amp,kitchen-amp] [--pi-only]
//     [--silent] [--force] [--restart] [--only tiers] [--skip tiers] [--reboot]
//
// Needs: ssh access as the inventory's ansible_user with passwordless sudo
// (what Ansible already uses), HOME_ASSISTANT_TOKEN in the environment for
// the Home Assistant checks, and sox (brew install sox) for the USB one.
// Nothing here is deployed; see docs/e2e.md.

import {execFile, spawn} from 'node:child_process'
import dgram from 'node:dgram'
import dns from 'node:dns/promises'
import {mkdirSync, writeFileSync} from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'

const execFileAsync = promisify(execFile)

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const REPORTS = path.join(REPO, 'tools/e2e/reports')
const ANSIBLE_ENV = {...process.env, ANSIBLE_CONFIG: path.join(REPO, 'ansible/ansible.cfg')}

const SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10']
const OBSERVE_SECONDS = {usb: 15, notify: 15, voice: 30, player: 30}
const REBOOT_WAIT_SECONDS = 240
const TONE_HZ = 1000
// -20 dBFS, the same stimulus the Pi plays itself.
const TONE_VOLUME = 0.1
// A tone from the computer arrives untrimmed at the music level the observer
// parks the amp at; the tone must at least clear this, whatever the host's
// own mixer does to it on the way.
const USB_MIN_TONE_DB = -65
const VOICE_MIN_LEVEL = 0.2

function parseArguments(argv) {
    const options = {limit: [], piOnly: false, reboot: false, pi: []}
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index]
        const value = () => argv[++index] ?? ''
        switch (argument) {
            case '--limit': options.limit = value().split(',').map((h) => h.trim()).filter(Boolean); break
            case '--pi-only': options.piOnly = true; break
            case '--reboot': options.reboot = true; break
            case '--only': options.pi.push('--only', value()); break
            case '--skip': options.pi.push('--skip', value()); break
            case '--level': options.pi.push('--level', value()); break
            case '--min-rise-db': options.pi.push('--min-rise-db', value()); break
            case '--silent': case '--force': case '--restart': options.pi.push(argument); break
            default: throw new Error(`unknown argument ${argument}`)
        }
    }
    return options
}

// Inventory, as Ansible resolves it. A handful of names default to Jinja
// expressions of the hostname, which ansible-inventory hands back unrendered.
async function inventory(host) {
    const {stdout} = await execFileAsync('ansible-inventory', ['--host', host], {env: ANSIBLE_ENV})
    const raw = JSON.parse(stdout)
    const render = (value) => String(value ?? '')
        .replace(/\{\{\s*smartamp_hostname\s*\}\}/g, host)
        .replace(/\{\{\s*inventory_hostname\s*\}\}/g, host)
    return {
        name: host,
        address: raw.ansible_host ?? host,
        user: raw.ansible_user ?? os.userInfo().username,
        usbGadget: Boolean(raw.usb_audio_gadget_enabled),
        usbProduct: render(raw.usb_audio_product || '{{ smartamp_hostname }} USB'),
        controllerUsesHomeAssistant: Boolean(render(raw.home_assistant_url)),
        voice: Boolean(raw.voice_assistant_enabled),
        voiceName: render(raw.voice_assistant_name || '{{ smartamp_hostname }} Voice'),
        ducking: Boolean(raw.voice_assistant_enabled) && raw.smartamp_voice_ducking_enabled !== false,
        sendspin: Boolean(raw.sendspin_enabled),
        sendspinName: render(raw.sendspin_name || '{{ smartamp_hostname }}'),
    }
}

// Where Home Assistant is, whichever unit asks: a unit that leaves its own
// URL empty only keeps its controller off it, and its satellite and player
// are still Home Assistant's.
async function homeAssistantUrl() {
    if (process.env.HOME_ASSISTANT_URL) return process.env.HOME_ASSISTANT_URL
    const {stdout} = await execFileAsync('ansible-inventory', ['--list', '--export'], {env: ANSIBLE_ENV})
    return String(JSON.parse(stdout).all?.vars?.home_assistant_url ?? '')
}

async function hosts(limit) {
    const {stdout} = await execFileAsync('ansible-inventory', ['--list'], {env: ANSIBLE_ENV})
    const listed = JSON.parse(stdout).smartamp?.hosts ?? []
    if (!limit.length) return listed
    const unknown = limit.filter((name) => !listed.includes(name))
    if (unknown.length) throw new Error(`not in the inventory: ${unknown.join(', ')}`)
    return limit
}

// SSH. The remote shell re-splits the command, so every argument is quoted.

const shellQuote = (argument) => `'${String(argument).replace(/'/g, `'\\''`)}'`

function ssh(unit, command, {timeoutMs = 600_000} = {}) {
    return new Promise((resolve) => {
        const child = spawn('ssh', [...SSH_OPTIONS, `${unit.user}@${unit.address}`, command], {stdio: ['ignore', 'pipe', 'pipe']})
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (chunk) => { stdout += chunk })
        child.stderr.on('data', (chunk) => { stderr += chunk })
        const timer = setTimeout(() => child.kill(), timeoutMs)
        child.on('close', (code) => {
            clearTimeout(timer)
            resolve({code, stdout, stderr})
        })
    })
}

async function selftest(unit, flags) {
    const command = ['sudo', 'smartamp-selftest', '--json', ...flags].map(shellQuote).join(' ')
    const result = await ssh(unit, command)
    const start = result.stdout.indexOf('{')
    if (start < 0) {
        return {ok: false, checks: [{tier: 'ssh', name: 'smartamp-selftest ran', outcome: 'FAIL',
            detail: (result.stderr || result.stdout).trim().split('\n').pop() || `exit ${result.code}`}]}
    }
    return JSON.parse(result.stdout.slice(start))
}

// Never rejects: it is left pending while the stimulus plays, and a rejection
// with no handler yet would end the whole run.
function observe(unit, what, seconds, marker = '') {
    const command = ['sudo', 'smartamp-selftest', 'observe', what, '--seconds', String(seconds),
        ...(marker ? ['--marker', marker] : [])].map(shellQuote).join(' ')
    return ssh(unit, command, {timeoutMs: (seconds + 60) * 1000}).then((result) => {
        const start = result.stdout.indexOf('{')
        if (start < 0) return {failed: (result.stderr || result.stdout).trim() || `observe ${what} exit ${result.code}`}
        try {
            return JSON.parse(result.stdout.slice(start))
        } catch (error) {
            return {failed: `observe ${what} printed unreadable JSON: ${error.message}`}
        }
    })
}

const unobserved = (tier, seen) => check(tier, 'the amp observed it', false, seen.failed)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Home Assistant, over its REST API.

class HomeAssistant {
    constructor(url, token) {
        this.url = url.replace(/\/$/, '')
        this.token = token
    }

    async request(method, route, body) {
        const response = await fetch(`${this.url}${route}`, {
            method,
            headers: {Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json'},
            body: body === undefined ? undefined : JSON.stringify(body),
        })
        if (!response.ok) throw new Error(`Home Assistant ${method} ${route}: ${response.status} ${await response.text()}`)
        return response.status === 204 ? null : response.json()
    }

    fireEvent(type, data) { return this.request('POST', `/api/events/${type}`, data) }

    call(domain, service, data) { return this.request('POST', `/api/services/${domain}/${service}`, data) }

    async states() { return this.request('GET', '/api/states') }

    // The entity Home Assistant gave a device, found by the name the
    // inventory gave it; ids are not derivable from names.
    async entityNamed(domain, name) {
        const wanted = name.trim().toLowerCase()
        const candidates = (await this.states())
            .filter((state) => state.entity_id.startsWith(`${domain}.`))
            .map((state) => ({id: state.entity_id, name: String(state.attributes?.friendly_name ?? '').toLowerCase()}))
        const exact = candidates.find((c) => c.name === wanted)
        if (exact) return exact.id
        const containing = candidates.filter((c) => c.name.includes(wanted) || c.id.includes(wanted.replace(/\s+/g, '_')))
        if (containing.length === 1) return containing[0].id
        return null
    }
}

// The tone this computer serves and plays.

function toneWav(seconds, rate = 48000) {
    const frames = seconds * rate
    const data = Buffer.alloc(frames * 4)
    for (let index = 0; index < frames; index++) {
        const sample = Math.round(TONE_VOLUME * Math.sin(2 * Math.PI * TONE_HZ * index / rate) * 32767)
        data.writeInt16LE(sample, index * 4)
        data.writeInt16LE(sample, index * 4 + 2)
    }
    const header = Buffer.alloc(44)
    header.write('RIFF', 0)
    header.writeUInt32LE(36 + data.length, 4)
    header.write('WAVE', 8)
    header.write('fmt ', 12)
    header.writeUInt32LE(16, 16)
    header.writeUInt16LE(1, 20)
    header.writeUInt16LE(2, 22)
    header.writeUInt32LE(rate, 24)
    header.writeUInt32LE(rate * 4, 28)
    header.writeUInt16LE(4, 32)
    header.writeUInt16LE(16, 34)
    header.write('data', 36)
    header.writeUInt32LE(data.length, 40)
    return Buffer.concat([header, data])
}

async function lanAddressTowards(host) {
    const {address} = await dns.lookup(host)
    return new Promise((resolve) => {
        const probe = dgram.createSocket('udp4')
        probe.connect(9, address, () => {
            const local = probe.address().address
            probe.close()
            resolve(local)
        })
        probe.on('error', () => {
            probe.close()
            const candidate = Object.values(os.networkInterfaces()).flat()
                .find((entry) => entry && entry.family === 'IPv4' && !entry.internal)
            resolve(candidate?.address ?? '127.0.0.1')
        })
    })
}

async function serveTone(seconds, address) {
    const body = toneWav(seconds)
    const server = http.createServer((request, response) => {
        response.writeHead(200, {'Content-Type': 'audio/wav', 'Content-Length': body.length})
        response.end(request.method === 'HEAD' ? undefined : body)
    })
    await new Promise((resolve) => server.listen(0, address, resolve))
    return {url: `http://${address}:${server.address().port}/selftest-tone.wav`, close: () => server.close()}
}

async function coreAudioDevices() {
    try {
        const {stdout} = await execFileAsync('system_profiler', ['SPAudioDataType', '-json'])
        return (JSON.parse(stdout).SPAudioDataType ?? []).flatMap((group) => group._items ?? []).map((item) => item._name)
    } catch {
        return []
    }
}

async function haveSox() {
    try {
        await execFileAsync('sox', ['--version'])
        return true
    } catch {
        return false
    }
}

function playToneOn(device, seconds) {
    return execFileAsync('sox', ['-q', '-n', '-r', '48000', '-c', '2', '-t', 'coreaudio', device,
        'synth', String(seconds), 'sine', String(TONE_HZ), 'vol', String(TONE_VOLUME)])
}

// The checks made from here.

function check(tier, name, ok, detail = '', {skip = false, warn = false} = {}) {
    return {tier, name, outcome: skip ? 'SKIP' : ok ? 'PASS' : warn ? 'WARN' : 'FAIL', detail}
}

const describe = (seen) => Object.entries(seen)
    .filter(([key]) => !['observation', 'seconds'].includes(key))
    .map(([key, value]) => `${key}=${value}`).join(' ')

async function usbCheck(unit) {
    const tier = 'usb'
    if (!unit.usbGadget) return [check(tier, 'USB sound card', true, 'not a sound card', {skip: true})]
    if (!await haveSox()) return [check(tier, 'sox is installed', true, 'brew install sox to play into the sound card', {skip: true})]
    const devices = await coreAudioDevices()
    if (!devices.includes(unit.usbProduct)) {
        return [check(tier, `"${unit.usbProduct}" is attached to this computer`, true,
            `not among ${devices.join(', ') || 'no audio devices'}`, {skip: true})]
    }
    const observation = observe(unit, 'usb', OBSERVE_SECONDS.usb)
    await sleep(2000)
    let played = null
    try {
        await playToneOn(unit.usbProduct, 8)
    } catch (error) {
        played = String(error.message ?? error).split('\n')[0]
    }
    const seen = await observation
    const playedCheck = check(tier, 'this computer played into the sound card', played === null, played ?? '')
    if (seen.failed) return [playedCheck, unobserved(tier, seen)]
    return [
        playedCheck,
        check(tier, 'the amp saw a host attached and streaming', seen.host && seen.streaming, describe(seen)),
        check(tier, 'the USB stream reached the music bus', Boolean(seen.stream_on_bus), describe(seen)),
        check(tier, 'the tone reached the output', typeof seen.tone_db === 'number' && seen.tone_db >= USB_MIN_TONE_DB,
            `tone ${seen.tone_db ?? 'not measured'} dBFS at the output, needed ${USB_MIN_TONE_DB}`),
    ]
}

async function notifyCheck(unit, ha) {
    const tier = 'home-assistant'
    if (!unit.controllerUsesHomeAssistant) return [check(tier, 'smartamp_notify', true, "this unit's controller does not use Home Assistant", {skip: true})]
    if (!ha) return [check(tier, 'smartamp_notify', true, 'HOME_ASSISTANT_TOKEN is not set', {skip: true})]
    const marker = `SELFTEST ${Date.now().toString(36).toUpperCase()}`
    const observation = observe(unit, 'notify', OBSERVE_SECONDS.notify, marker)
    await sleep(1500)
    try {
        await ha.fireEvent('smartamp_notify', {title: 'SELF TEST', message: marker, seconds: 3})
    } catch (error) {
        await observation
        return [check(tier, 'smartamp_notify was fired', false, String(error.message ?? error))]
    }
    const seen = await observation
    if (seen.failed) return [unobserved(tier, seen)]
    return [check(tier, 'smartamp_notify reached the controller', Boolean(seen.seen),
        seen.seen ? marker : `no "${marker}" in the controller journal within ${OBSERVE_SECONDS.notify}s`)]
}

async function voiceCheck(unit, ha) {
    const tier = 'voice-satellite'
    if (!unit.voice) return [check(tier, 'announce', true, 'no voice assistant on this unit', {skip: true})]
    if (!ha) return [check(tier, 'announce', true, 'HOME_ASSISTANT_TOKEN is not set', {skip: true})]
    const entity = await ha.entityNamed('assist_satellite', unit.voiceName)
    if (!entity) return [check(tier, `satellite "${unit.voiceName}" is in Home Assistant`, false, 'no assist_satellite entity with that name')]
    const observation = observe(unit, 'voice', OBSERVE_SECONDS.voice)
    await sleep(2000)
    try {
        await ha.call('assist_satellite', 'announce', {entity_id: entity, message: 'Self test. The voice bus is working.'})
    } catch (error) {
        await observation
        return [check(tier, 'the satellite accepted an announcement', false, String(error.message ?? error))]
    }
    const seen = await observation
    if (seen.failed) return [check(tier, `${entity} accepted an announcement`, true), unobserved(tier, seen)]
    return [
        check(tier, `${entity} accepted an announcement`, true),
        check(tier, 'the announcement played on the voice bus', Boolean(seen.voice_stream), describe(seen)),
        check(tier, 'the voice meter heard it', Number(seen.peak_level) >= VOICE_MIN_LEVEL, `peak level ${seen.peak_level}`),
        check(tier, 'the controller ducked the music for it', !unit.ducking || Boolean(seen.ducked),
            unit.ducking ? describe(seen) : 'ducking is off on this unit', {skip: !unit.ducking}),
    ]
}

async function playerCheck(unit, ha) {
    const tier = 'sendspin'
    if (!unit.sendspin) return [check(tier, 'play_media', true, 'no Sendspin player on this unit', {skip: true})]
    if (!ha) return [check(tier, 'play_media', true, 'HOME_ASSISTANT_TOKEN is not set', {skip: true})]
    const entity = await ha.entityNamed('media_player', unit.sendspinName)
    if (!entity) return [check(tier, `player "${unit.sendspinName}" is in Home Assistant`, false, 'no media_player entity with that name')]
    const address = await lanAddressTowards(unit.address)
    const tone = await serveTone(20, address)
    try {
        const observation = observe(unit, 'player', OBSERVE_SECONDS.player)
        await sleep(2000)
        try {
            await ha.call('media_player', 'play_media', {entity_id: entity, media_content_id: tone.url, media_content_type: 'music'})
        } catch (error) {
            await observation
            return [check(tier, 'the player accepted a stream', false, String(error.message ?? error))]
        }
        const seen = await observation
        await ha.call('media_player', 'media_stop', {entity_id: entity}).catch(() => null)
        if (seen.failed) return [check(tier, `${entity} accepted a stream from ${tone.url}`, true), unobserved(tier, seen)]
        return [
            check(tier, `${entity} accepted a stream from ${tone.url}`, true),
            check(tier, 'the player streamed onto the music bus', Boolean(seen.stream_on_bus) && Boolean(seen.source_available), describe(seen)),
            check(tier, 'the stream reached the output', typeof seen.rms_db === 'number' && seen.rms_db > -90, `rms ${seen.rms_db ?? 'not measured'} dBFS`),
        ]
    } finally {
        tone.close()
    }
}

async function rebootCheck(unit) {
    const tier = 'reboot'
    await ssh(unit, 'sudo systemctl reboot', {timeoutMs: 15_000})
    const started = Date.now()
    await sleep(15_000)
    let back = false
    while (Date.now() - started < REBOOT_WAIT_SECONDS * 1000) {
        const probe = await ssh(unit, 'true', {timeoutMs: 15_000})
        if (probe.code === 0) { back = true; break }
        await sleep(5000)
    }
    const seconds = Math.round((Date.now() - started) / 1000)
    if (!back) return [check(tier, 'the amp came back', false, `no ssh after ${seconds}s`)]
    // Give the audio stack its readiness gate before asking it anything.
    await sleep(20_000)
    const after = await selftest(unit, ['--silent', '--only', 'services,hardware,commands,playback'])
    return [check(tier, 'the amp came back', true, `ssh after ${seconds}s`), ...after.checks.map((c) => ({...c, tier: `reboot:${c.tier}`}))]
}

// Output.

function render(host, checks) {
    const lines = [`\n#### ${host}`]
    let tier = null
    for (const item of checks) {
        if (item.tier !== tier) {
            tier = item.tier
            lines.push(`\n== ${tier} ==`)
        }
        lines.push(`${item.outcome.padEnd(5)} ${item.name}${item.detail ? `: ${item.detail}` : ''}`)
    }
    const counts = {}
    for (const item of checks) counts[item.outcome] = (counts[item.outcome] ?? 0) + 1
    lines.push(`\n${Object.entries(counts).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(', ')}`)
    return lines.join('\n')
}

async function runHost(name, options, ha) {
    const unit = await inventory(name)
    const pi = await selftest(unit, options.pi)
    const checks = [...pi.checks]
    if (!options.piOnly) {
        for (const step of [usbCheck, notifyCheck, voiceCheck, playerCheck]) {
            try {
                checks.push(...await step(unit, ha))
            } catch (error) {
                checks.push(check(step.name.replace(/Check$/, ''), `${step.name} ran`, false, String(error.message ?? error)))
            }
        }
        if (options.reboot) checks.push(...await rebootCheck(unit))
    }
    return {host: name, checks, ok: checks.every((c) => c.outcome !== 'FAIL')}
}

async function main() {
    const options = parseArguments(process.argv.slice(2))
    const token = process.env.HOME_ASSISTANT_TOKEN ?? ''
    if (!token) console.log('HOME_ASSISTANT_TOKEN is not set; the Home Assistant, voice and player checks will be skipped')
    const url = token ? await homeAssistantUrl() : ''
    const ha = url && token ? new HomeAssistant(url, token) : null
    mkdirSync(REPORTS, {recursive: true})
    let failed = false
    for (const name of await hosts(options.limit)) {
        console.log(`\nRunning the self-test on ${name} ...`)
        const result = await runHost(name, options, ha)
        console.log(render(name, result.checks))
        const file = path.join(REPORTS, `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
        writeFileSync(file, JSON.stringify(result, null, 2))
        console.log(`report: ${path.relative(REPO, file)}`)
        failed ||= !result.ok
    }
    process.exitCode = failed ? 1 : 0
}

main().catch((error) => {
    console.error(error.message ?? error)
    process.exitCode = 2
})
