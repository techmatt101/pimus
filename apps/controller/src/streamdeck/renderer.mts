import type { StreamDeck } from '@elgato-stream-deck/node'

import { createImage, drawRectangle, drawText } from './bitmap.mjs'
import { indicatorFor } from '../actions/catalog.mjs'
import type { AudioState, ControlState, StreamDeckConfig, StreamDeckDial, StreamDeckKey } from '../types.mjs'

export interface KeyAppearance {
  label: string
  background: string
}

/**
 * The face of a key, derived entirely from its bound action's catalog entry.
 * An action with no indicator simply keeps its configured label and colour.
 */
export function keyAppearance(
  key: StreamDeckKey,
  state: ControlState,
  audioState: AudioState = { sources: {} },
): KeyAppearance {
  const indicator = indicatorFor(key.action)
  if (!indicator) return { label: key.label, background: key.color }

  const active = indicator.isActive({ state, audio: audioState, source: key.action?.source })
  return {
    label: indicator.label ? indicator.label(key.label, active) : key.label,
    background: active ? indicator.activeColor : key.color,
  }
}

/**
 * The value line under a dial's label. What a dial reports follows from the
 * actions bound to it rather than its position, so reordering `streamdeck_dials`
 * keeps each dial's readout correct.
 */
export function dialDetail(
  state: ControlState,
  audioState: AudioState = { sources: {} },
  dial?: StreamDeckDial,
): string {
  const actions = [dial?.press, dial?.left, dial?.right]
  const source = actions.find((action) => action?.source)?.source
  if (source) return audioState.sources[source] ? 'ON' : 'OFF'
  if (actions.some((action) => action?.type === 'audio' && !action.source)) {
    return state.outputMuted ? 'MUTED' : `${Math.round(state.volume * 100)}%`
  }
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
      // Draw all eight keys: the deck retains its last image, so slots without
      // a configured key must be blanked rather than skipped.
      for (let index = 0; index < 8; index += 1) {
        const key = config.keys[index]
        if (!key) {
          await deck.fillKeyBuffer(index, createImage(120, 120, '#000000').buffer, { format: 'rgb' })
          continue
        }
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
        const detail = dialDetail(this.state, audioState, dial).slice(0, 12)
        drawText(lcd, detail, index * 200 + 100, 70, detail.length > 8 ? 2 : 3)
      })
      await deck.fillLcd(0, lcd.buffer, { format: 'rgb' })
    } catch (error) {
      this.logger.error('render failed', error)
    }
  }
}
