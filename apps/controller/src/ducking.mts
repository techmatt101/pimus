import fs from 'node:fs'
import path from 'node:path'

import type { LvaMessage } from './types.mjs'

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

export type DuckWriter = (stateFile: string, active: boolean, now?: number) => void

/** Returns the requested duck state, or null when the event is irrelevant. */
export function duckingForEvent(message: LvaMessage | undefined): boolean | null {
  const event = String(message?.event || '')
  if (ACTIVE_EVENTS.has(event)) return true
  if (RELEASE_EVENTS.has(event) || event === 'snapshot') return false
  return null
}

export function writeDuckRequest(stateFile: string, active: boolean, now: number = Date.now()): void {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true })
  const temporary = `${stateFile}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify({
    active: Boolean(active),
    updated_at: now / 1000,
  }, null, 2)}\n`)
  fs.renameSync(temporary, stateFile)
}

export interface VoiceDuckerOptions {
  stateFile: string
  refreshMilliseconds?: number
  writeRequest?: DuckWriter
}

export class VoiceDucker {
  readonly stateFile: string
  readonly refreshMilliseconds: number
  readonly writeRequest: DuckWriter
  active = false
  private refreshTimer: NodeJS.Timeout | null = null

  constructor({
    stateFile,
    refreshMilliseconds = 30000,
    writeRequest = writeDuckRequest,
  }: VoiceDuckerOptions) {
    this.stateFile = stateFile
    this.refreshMilliseconds = refreshMilliseconds
    this.writeRequest = writeRequest
  }

  setActive(active: boolean): void {
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

  handleEvent(message: LvaMessage | undefined): void {
    const active = duckingForEvent(message)
    if (active !== null) this.setActive(active)
  }

  release(): void {
    this.setActive(false)
  }
}
