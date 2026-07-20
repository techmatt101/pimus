import fs from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { listStreamDecks, openStreamDeck } from '@elgato-stream-deck/node'
import WebSocket from 'ws'

const configPath = process.env.SMARTAMP_CONFIG || '/etc/smartamp/streamdeck.json'
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const execFileAsync = promisify(execFile)

const FONT = {
  ' ': ['00000','00000','00000','00000','00000','00000','00000'],
  '-': ['00000','00000','00000','11111','00000','00000','00000'],
  ':': ['00000','00100','00100','00000','00100','00100','00000'],
  '%': ['11001','11010','00100','01000','10110','00110','00000'],
  '.': ['00000','00000','00000','00000','00000','00110','00110'],
  '0': ['01110','10001','10011','10101','11001','10001','01110'],
  '1': ['00100','01100','00100','00100','00100','00100','01110'],
  '2': ['01110','10001','00001','00010','00100','01000','11111'],
  '3': ['11110','00001','00001','01110','00001','00001','11110'],
  '4': ['00010','00110','01010','10010','11111','00010','00010'],
  '5': ['11111','10000','10000','11110','00001','00001','11110'],
  '6': ['01110','10000','10000','11110','10001','10001','01110'],
  '7': ['11111','00001','00010','00100','01000','01000','01000'],
  '8': ['01110','10001','10001','01110','10001','10001','01110'],
  '9': ['01110','10001','10001','01111','00001','00001','01110'],
  A: ['01110','10001','10001','11111','10001','10001','10001'],
  B: ['11110','10001','10001','11110','10001','10001','11110'],
  C: ['01111','10000','10000','10000','10000','10000','01111'],
  D: ['11110','10001','10001','10001','10001','10001','11110'],
  E: ['11111','10000','10000','11110','10000','10000','11111'],
  F: ['11111','10000','10000','11110','10000','10000','10000'],
  G: ['01111','10000','10000','10111','10001','10001','01111'],
  H: ['10001','10001','10001','11111','10001','10001','10001'],
  I: ['01110','00100','00100','00100','00100','00100','01110'],
  J: ['00001','00001','00001','00001','10001','10001','01110'],
  K: ['10001','10010','10100','11000','10100','10010','10001'],
  L: ['10000','10000','10000','10000','10000','10000','11111'],
  M: ['10001','11011','10101','10101','10001','10001','10001'],
  N: ['10001','11001','10101','10011','10001','10001','10001'],
  O: ['01110','10001','10001','10001','10001','10001','01110'],
  P: ['11110','10001','10001','11110','10000','10000','10000'],
  Q: ['01110','10001','10001','10001','10101','10010','01101'],
  R: ['11110','10001','10001','11110','10100','10010','10001'],
  S: ['01111','10000','10000','01110','00001','00001','11110'],
  T: ['11111','00100','00100','00100','00100','00100','00100'],
  U: ['10001','10001','10001','10001','10001','10001','01110'],
  V: ['10001','10001','10001','10001','10001','01010','00100'],
  W: ['10001','10001','10001','10101','10101','10101','01010'],
  X: ['10001','10001','01010','00100','01010','10001','10001'],
  Y: ['10001','10001','01010','00100','00100','00100','00100'],
  Z: ['11111','00001','00010','00100','01000','10000','11111'],
}

let deck = null
let lva = null
let renderPending = false
const state = { assist: 'DISCONNECTED', muted: false, volume: 1, outputMuted: false, media: false }

function color(value) {
  const parsed = Number.parseInt(String(value).replace('#', ''), 16)
  return [(parsed >> 16) & 255, (parsed >> 8) & 255, parsed & 255]
}

function image(width, height, background = '#000000') {
  const buffer = Buffer.alloc(width * height * 3)
  const rgb = color(background)
  for (let offset = 0; offset < buffer.length; offset += 3) {
    buffer[offset] = rgb[0]
    buffer[offset + 1] = rgb[1]
    buffer[offset + 2] = rgb[2]
  }
  return { width, height, buffer }
}

function rectangle(target, x, y, width, height, value) {
  const rgb = color(value)
  for (let py = Math.max(0, y); py < Math.min(target.height, y + height); py += 1) {
    for (let px = Math.max(0, x); px < Math.min(target.width, x + width); px += 1) {
      const offset = (py * target.width + px) * 3
      target.buffer[offset] = rgb[0]
      target.buffer[offset + 1] = rgb[1]
      target.buffer[offset + 2] = rgb[2]
    }
  }
}

function text(target, value, centerX, centerY, scale, valueColor = '#ffffff') {
  const label = String(value).toUpperCase()
  const glyphWidth = 5 * scale
  const totalWidth = label.length * (glyphWidth + scale) - scale
  let left = Math.round(centerX - totalWidth / 2)
  const top = Math.round(centerY - (7 * scale) / 2)
  for (const character of label) {
    const glyph = FONT[character] || FONT[' ']
    glyph.forEach((row, y) => [...row].forEach((bit, x) => {
      if (bit === '1') rectangle(target, left + x * scale, top + y * scale, scale, scale, valueColor)
    }))
    left += glyphWidth + scale
  }
}

function readAudioState() {
  try { return JSON.parse(fs.readFileSync(config.audio_state_file, 'utf8')) }
  catch { return { sources: {} } }
}

function keyAppearance(key) {
  let label = key.label
  let background = key.color
  const audio = readAudioState()
  if (key.action?.type === 'audio' && key.action?.source) {
    const enabled = Boolean(audio.sources?.[key.action.source])
    background = enabled ? '#1b5e20' : key.color
    label = `${key.label} ${enabled ? 'ON' : 'OFF'}`
  } else if (key.action?.command === 'mute_toggle' && state.muted) {
    label = 'MIC OFF'
    background = '#d50000'
  } else if (key.action?.command === 'start_listening' && ['LISTENING', 'THINKING'].includes(state.assist)) {
    background = '#00b8d4'
  } else if (key.action?.command === 'media_toggle' && state.media) {
    label = 'PAUSE'
    background = '#00c853'
  }
  return { label, background }
}

async function render() {
  renderPending = false
  if (!deck) return
  try {
    for (let index = 0; index < Math.min(8, config.keys.length); index += 1) {
      const appearance = keyAppearance(config.keys[index])
      const target = image(120, 120, appearance.background)
      rectangle(target, 0, 94, 120, 26, '#000000')
      const scale = appearance.label.length > 8 ? 2 : 3
      text(target, appearance.label, 60, 106, scale)
      await deck.fillKeyBuffer(index, target.buffer, { format: 'rgb' })
    }
    const lcd = image(800, 100, '#101820')
    config.dials.slice(0, 4).forEach((dial, index) => {
      rectangle(lcd, index * 200 + 1, 1, 198, 98, index % 2 ? '#17242d' : '#101820')
      text(lcd, dial.label, index * 200 + 100, 30, 3, '#80deea')
      const detail = index === 0 ? (state.outputMuted ? 'MUTED' : `${Math.round(state.volume * 100)}%`) : state.assist
      text(lcd, detail.slice(0, 12), index * 200 + 100, 70, detail.length > 8 ? 2 : 3)
    })
    await deck.fillLcd(0, lcd.buffer, { format: 'rgb' })
  } catch (error) {
    console.error('render failed', error)
  }
}

function scheduleRender() {
  if (renderPending) return
  renderPending = true
  setTimeout(render, 50)
}

function sendLva(command, data) {
  if (lva?.readyState !== WebSocket.OPEN) return
  lva.send(JSON.stringify({ command, ...(data ? { data } : {}) }))
}

function control(args) {
  const child = spawn('/usr/local/bin/smartampctl', args, { stdio: 'inherit' })
  child.on('exit', () => setTimeout(scheduleRender, 300))
}

async function action(value) {
  if (!value || value.type === 'noop') return
  if (value.type === 'lva') {
    if (value.command === 'mute_toggle') sendLva(state.muted ? 'unmute_mic' : 'mute_mic')
    else if (value.command === 'media_toggle') {
      sendLva(state.media ? 'pause_media_player' : 'resume_media_player')
      state.media = !state.media
      scheduleRender()
    }
    else if (value.command === 'stop') {
      sendLva('stop_timer_ringing'); sendLva('stop_pipeline'); sendLva('stop_media_player')
      state.media = false
      scheduleRender()
    } else sendLva(value.command)
  } else if (value.type === 'audio') {
    if (value.source) control(['source', value.source, value.command])
    else control(['volume', value.command])
  } else if (value.type === 'led') {
    control(['lights', value.command])
  } else if (value.type === 'webhook' && config.webhook_base && value.id) {
    await fetch(`${config.webhook_base.replace(/\/$/, '')}/${encodeURIComponent(value.id)}`, { method: 'POST' })
  }
}

function connectLva() {
  lva = new WebSocket(config.lva_uri)
  lva.on('open', () => console.log('connected to voice assistant'))
  lva.on('message', (raw) => {
    try {
      const message = JSON.parse(raw.toString())
      const data = message.data || {}
      if (message.event === 'snapshot') {
        state.muted = Boolean(data.muted); state.volume = Number(data.volume ?? 1)
        state.assist = data.ha_connected ? 'IDLE' : 'DISCONNECTED'
      } else if (message.event === 'muted') state.muted = Boolean(data.muted)
      else if (message.event === 'volume_changed') state.volume = Number(data.volume)
      else if (message.event === 'media_player_playing') state.media = true
      else if (message.event === 'idle' || message.event === 'tts_finished') state.assist = 'IDLE'
      else if (message.event === 'disconnected') state.assist = 'DISCONNECTED'
      else if (message.event) state.assist = String(message.event).toUpperCase()
      scheduleRender()
    } catch (error) { console.error('invalid voice event', error) }
  })
  lva.on('close', () => { state.assist = 'DISCONNECTED'; scheduleRender(); setTimeout(connectLva, 3000) })
  lva.on('error', () => {})
}

async function deckLoop() {
  while (true) {
    try {
      const devices = await listStreamDecks()
      if (devices.length === 0) { await sleep(3000); continue }
      deck = await openStreamDeck(devices[0].path)
      console.log(`opened ${deck.PRODUCT_NAME}`)
      await deck.setBrightness(config.brightness)
      await render()
      const disconnected = new Promise((resolve) => deck.once('error', resolve))
      deck.on('down', (controlDefinition) => {
        if (controlDefinition.type === 'button') action(config.keys[controlDefinition.index]?.action)
        else if (controlDefinition.type === 'encoder') action(config.dials[controlDefinition.index]?.press)
      })
      deck.on('rotate', (controlDefinition, amount) => {
        const dial = config.dials[controlDefinition.index]
        const selected = amount < 0 ? dial?.left : dial?.right
        for (let count = 0; count < Math.min(10, Math.abs(amount)); count += 1) action(selected)
      })
      deck.on('lcdShortPress', (_controlDefinition, position) => {
        action(config.dials[Math.min(3, Math.floor(position.x / 200))]?.press)
      })
      await disconnected
    } catch (error) {
      console.error('Stream Deck unavailable', error)
    } finally {
      try { await deck?.close() } catch {}
      deck = null
    }
    await sleep(3000)
  }
}

connectLva()
setInterval(async () => {
  try {
    const { stdout } = await execFileAsync('wpctl', ['get-volume', '@DEFAULT_AUDIO_SINK@'])
    const match = stdout.match(/Volume:\s+([0-9.]+)/)
    if (match) state.volume = Number(match[1])
    state.outputMuted = stdout.includes('[MUTED]')
    scheduleRender()
  } catch {}
}, 1000)
await deckLoop()
