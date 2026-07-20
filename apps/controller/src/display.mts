import type { StreamDeck } from '@elgato-stream-deck/node'

import { createImage, drawRectangle, drawText } from './bitmap.mjs'
import type { AudioState, ControlState, StreamDeckConfig, StreamDeckDial, StreamDeckKey } from './types.mjs'

export interface KeyAppearance {
  label: string
  background: string
}

export function keyAppearance(
  key: StreamDeckKey,
  state: ControlState,
  audioState: AudioState = { sources: {} },
): KeyAppearance {
  let label = key.label
  let background = key.color
  if (key.action?.type === 'audio' && key.action?.source) {
    const enabled = Boolean(audioState.sources?.[key.action.source])
    background = enabled ? '#1b5e20' : key.color
    label = `${key.label} ${enabled ? 'ON' : 'OFF'}`
  } else if (key.action?.command === 'mute_toggle' && state.muted) {
    label = 'MIC OFF'
    background = '#d50000'
  } else if (key.action?.command === 'start_listening'
      && ['WAKE_WORD_DETECTED', 'LISTENING', 'THINKING', 'TTS_SPEAKING'].includes(state.assist)) {
    background = '#00b8d4'
  } else if (key.action?.command === 'media_toggle' && state.media) {
    label = 'PAUSE'
    background = '#00c853'
  }
  return { label, background }
}

export function dialDetail(
  index: number,
  state: ControlState,
  audioState: AudioState = { sources: {} },
  dial?: StreamDeckDial,
): string {
  if (index === 0) return state.outputMuted ? 'MUTED' : `${Math.round(state.volume * 100)}%`
  const source = dial?.press?.source ?? dial?.left?.source ?? dial?.right?.source
  if (source) return audioState.sources[source] ? 'ON' : 'OFF'
  return String(state.assist)
}

export interface DeckRendererOptions {
  /** Absent in LED-only deployments, where nothing is ever rendered. */
  config: StreamDeckConfig | undefined
  state: ControlState
  readAudioState: () => AudioState
  logger?: Pick<Console, 'error'>
}

export class DeckRenderer {
  readonly config: StreamDeckConfig | undefined
  readonly state: ControlState
  private readonly readAudioState: () => AudioState
  private readonly logger: Pick<Console, 'error'>
  private deck: StreamDeck | null = null
  private renderPending = false

  constructor({ config, state, readAudioState, logger = console }: DeckRendererOptions) {
    this.config = config
    this.state = state
    this.readAudioState = readAudioState
    this.logger = logger
  }

  setDeck(deck: StreamDeck): void {
    this.deck = deck
  }

  clearDeck(deck: StreamDeck | null): void {
    if (this.deck === deck) this.deck = null
  }

  schedule(): void {
    if (this.renderPending) return
    this.renderPending = true
    setTimeout(() => void this.render(), 50)
  }

  async render(): Promise<void> {
    this.renderPending = false
    const deck = this.deck
    const config = this.config
    if (!deck || !config) return
    try {
      const audioState = this.readAudioState()
      for (let index = 0; index < Math.min(8, config.keys.length); index += 1) {
        const key = config.keys[index]
        if (!key) continue
        const appearance = keyAppearance(key, this.state, audioState)
        const target = createImage(120, 120, appearance.background)
        drawRectangle(target, 0, 94, 120, 26, '#000000')
        drawText(target, appearance.label, 60, 106, appearance.label.length > 8 ? 2 : 3)
        await deck.fillKeyBuffer(index, target.buffer, { format: 'rgb' })
      }

      const lcd = createImage(800, 100, '#101820')
      config.dials.slice(0, 4).forEach((dial, index) => {
        drawRectangle(lcd, index * 200 + 1, 1, 198, 98, index % 2 ? '#17242d' : '#101820')
        drawText(lcd, dial.label, index * 200 + 100, 30, 3, '#80deea')
        const detail = dialDetail(index, this.state, audioState, dial).slice(0, 12)
        drawText(lcd, detail, index * 200 + 100, 70, detail.length > 8 ? 2 : 3)
      })
      await deck.fillLcd(0, lcd.buffer, { format: 'rgb' })
    } catch (error) {
      this.logger.error('render failed', error)
    }
  }
}
