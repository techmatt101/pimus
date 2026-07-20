import { createImage, drawRectangle, drawText } from './bitmap.mjs'

export function keyAppearance(key, state, audioState = { sources: {} }) {
  let label = key.label
  let background = key.color
  if (key.action?.type === 'audio' && key.action?.source) {
    const enabled = Boolean(audioState.sources?.[key.action.source])
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

export function dialDetail(index, state) {
  if (index === 0) return state.outputMuted ? 'MUTED' : `${Math.round(state.volume * 100)}%`
  return String(state.assist)
}

export class DeckRenderer {
  constructor({ config, state, readAudioState, logger = console }) {
    this.config = config
    this.state = state
    this.readAudioState = readAudioState
    this.logger = logger
    this.deck = null
    this.renderPending = false
  }

  setDeck(deck) {
    this.deck = deck
  }

  clearDeck(deck) {
    if (this.deck === deck) this.deck = null
  }

  schedule() {
    if (this.renderPending) return
    this.renderPending = true
    setTimeout(() => void this.render(), 50)
  }

  async render() {
    this.renderPending = false
    const deck = this.deck
    if (!deck) return
    try {
      const audioState = this.readAudioState()
      for (let index = 0; index < Math.min(8, this.config.keys.length); index += 1) {
        const appearance = keyAppearance(this.config.keys[index], this.state, audioState)
        const target = createImage(120, 120, appearance.background)
        drawRectangle(target, 0, 94, 120, 26, '#000000')
        drawText(target, appearance.label, 60, 106, appearance.label.length > 8 ? 2 : 3)
        await deck.fillKeyBuffer(index, target.buffer, { format: 'rgb' })
      }

      const lcd = createImage(800, 100, '#101820')
      this.config.dials.slice(0, 4).forEach((dial, index) => {
        drawRectangle(lcd, index * 200 + 1, 1, 198, 98, index % 2 ? '#17242d' : '#101820')
        drawText(lcd, dial.label, index * 200 + 100, 30, 3, '#80deea')
        const detail = dialDetail(index, this.state).slice(0, 12)
        drawText(lcd, detail, index * 200 + 100, 70, detail.length > 8 ? 2 : 3)
      })
      await deck.fillLcd(0, lcd.buffer, { format: 'rgb' })
    } catch (error) {
      this.logger.error('render failed', error)
    }
  }
}
