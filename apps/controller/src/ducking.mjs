import fs from 'node:fs'
import path from 'node:path'

const ACTIVE_EVENTS = new Set([
  'wake_word_detected',
  'listening',
  'thinking',
  'tts_speaking',
  'timer_ringing',
])

const RELEASE_EVENTS = new Set([
  'idle',
  'tts_finished',
  'pipeline_error',
  'disconnected',
])

export function duckingForEvent(message) {
  const event = String(message?.event || '')
  if (ACTIVE_EVENTS.has(event)) return true
  if (RELEASE_EVENTS.has(event) || event === 'snapshot') return false
  return null
}

export function writeDuckRequest(stateFile, active, now = Date.now()) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true })
  const temporary = `${stateFile}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify({
    active: Boolean(active),
    updated_at: now / 1000,
  }, null, 2)}\n`)
  fs.renameSync(temporary, stateFile)
}

export class VoiceDucker {
  constructor({
    stateFile,
    refreshMilliseconds = 30000,
    writeRequest = writeDuckRequest,
  }) {
    this.stateFile = stateFile
    this.refreshMilliseconds = refreshMilliseconds
    this.writeRequest = writeRequest
    this.active = false
    this.refreshTimer = null
  }

  setActive(active) {
    this.active = Boolean(active)
    this.writeRequest(this.stateFile, this.active)
    if (this.active && !this.refreshTimer && this.refreshMilliseconds > 0) {
      this.refreshTimer = setInterval(
        () => this.writeRequest(this.stateFile, true),
        this.refreshMilliseconds,
      )
      this.refreshTimer.unref?.()
    } else if (!this.active && this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
  }

  handleEvent(message) {
    const active = duckingForEvent(message)
    if (active !== null) this.setActive(active)
  }

  release() {
    this.setActive(false)
  }
}
