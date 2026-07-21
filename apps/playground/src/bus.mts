// The playground's event bus: everything the fakes observe funnels through
// here, and the browser page is just a view of it. Keeping the transport in one
// place means a fake only has to describe what happened, not how it is drawn.

import { EventEmitter } from 'node:events'

/** Which part of the controller a log line came from. Drives the UI colours. */
export type LogCategory =
  | 'system'
  | 'deck'
  | 'tile'
  | 'lva'
  | 'voice'
  | 'audio'
  | 'wpctl'
  | 'led'
  | 'duck'
  | 'webhook'

export interface LogEntry {
  time: number
  category: LogCategory
  /** Direction marker: what the controller sent, received, or did locally. */
  direction: 'out' | 'in' | 'note'
  message: string
  detail?: string
}

/** Everything the state panel shows, sampled from the live controller. */
export interface PlaygroundSnapshot {
  deckAttached: boolean
  lvaConnected: boolean
  audioConnected: boolean
  assist: string
  muted: boolean
  volume: number
  outputMuted: boolean
  media: boolean
  sources: Record<string, boolean | undefined>
  ducked: boolean
  led: { effect?: string; color?: string; accent?: string; brightness?: number } | null
}

export type Message =
  | { type: 'log'; entry: LogEntry }
  | { type: 'keys'; keys: Record<string, string>; lcd?: string }
  | { type: 'state'; state: PlaygroundSnapshot }

const LOG_HISTORY = 300

/**
 * Run-length encodes a raw RGB bitmap for the browser. The key faces are flat
 * colour with a little text, so this turns a 43 KB key into a few hundred
 * bytes — small enough that the MediaTile pulse streams without any
 * compression dependency.
 */
export function encodeRle(rgb: Buffer): string {
  const out: number[] = []
  let index = 0
  while (index + 2 < rgb.length) {
    const r = rgb[index] ?? 0
    const g = rgb[index + 1] ?? 0
    const b = rgb[index + 2] ?? 0
    let run = 1
    while (
      run < 255
      && index + run * 3 + 2 < rgb.length
      && rgb[index + run * 3] === r
      && rgb[index + run * 3 + 1] === g
      && rgb[index + run * 3 + 2] === b
    ) run += 1
    out.push(run, r, g, b)
    index += run * 3
  }
  return Buffer.from(out).toString('base64')
}

/**
 * Fan-out point between the fakes and every connected browser. It also retains
 * the last frame and a slice of log history so a page opened (or reloaded)
 * mid-session immediately shows the current deck rather than a blank grid.
 */
export class PlaygroundBus extends EventEmitter {
  private readonly history: LogEntry[] = []
  private readonly keyImages = new Map<number, string>()
  private lcdImage: string | undefined
  private snapshot: PlaygroundSnapshot | null = null

  log(category: LogCategory, direction: LogEntry['direction'], message: string, detail?: string): void {
    const entry: LogEntry = { time: Date.now(), category, direction, message, ...(detail ? { detail } : {}) }
    this.history.push(entry)
    if (this.history.length > LOG_HISTORY) this.history.shift()
    // Mirror to the terminal so the playground is still usable over SSH or
    // with the browser closed.
    process.stdout.write(`${category.padEnd(7)} ${message}${detail ? ` ${detail}` : ''}\n`)
    this.publish({ type: 'log', entry })
  }

  frame(keys: Record<string, string>, lcd?: string): void {
    for (const [index, image] of Object.entries(keys)) this.keyImages.set(Number(index), image)
    if (lcd) this.lcdImage = lcd
    this.publish({ type: 'keys', keys, ...(lcd ? { lcd } : {}) })
  }

  state(snapshot: PlaygroundSnapshot): void {
    this.snapshot = snapshot
    this.publish({ type: 'state', state: snapshot })
  }

  /** Everything a newly connected page needs to catch up, in display order. */
  replay(): Message[] {
    const messages: Message[] = []
    if (this.snapshot) messages.push({ type: 'state', state: this.snapshot })
    const keys = Object.fromEntries([...this.keyImages].map(([index, image]) => [String(index), image]))
    if (Object.keys(keys).length || this.lcdImage) {
      messages.push({ type: 'keys', keys, ...(this.lcdImage ? { lcd: this.lcdImage } : {}) })
    }
    for (const entry of this.history) messages.push({ type: 'log', entry })
    return messages
  }

  /** The deck went away; forget its face so a reload does not show a stale one. */
  clearFrame(): void {
    this.keyImages.clear()
    this.lcdImage = undefined
  }

  private publish(message: Message): void {
    this.emit('message', message)
  }
}

/**
 * A console-shaped logger that routes a module's own log/warn/error output into
 * the playground log instead of only the terminal.
 */
export function busLogger(bus: PlaygroundBus, category: LogCategory): Console {
  const write = (message: string, detail: unknown[]): void => {
    bus.log(category, 'note', message, detail.length ? detail.map(String).join(' ') : undefined)
  }
  return {
    log: (message: unknown, ...rest: unknown[]) => write(String(message), rest),
    warn: (message: unknown, ...rest: unknown[]) => write(String(message), rest),
    error: (message: unknown, ...rest: unknown[]) => write(String(message), rest),
  } as Console
}
