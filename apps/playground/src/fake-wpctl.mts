// A wpctl that moves a number instead of a PipeWire sink. It parses the real
// argument vectors audio/volume.mts builds and prints what real wpctl prints,
// so the dial -> spawn -> poll -> LCD round trip runs end to end: turning the
// volume dial changes this sink, and the controller's own output monitor is
// what notices and repaints.

import { EventEmitter } from 'node:events'
import type { ChildProcess, spawn } from 'node:child_process'

import type { PlaygroundBus } from './bus.mjs'
import type { CommandRunner } from '../../controller/src/audio/volume.mjs'

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value))

/** Reads a `5%+` / `5%-` / `0.4` style adjustment against the current volume. */
function applyAdjustment(current: number, adjustment: string, limit: number): number {
  const percent = adjustment.match(/^([0-9.]+)%([+-])$/)
  if (percent) {
    const step = Number(percent[1]) / 100
    return clamp(percent[2] === '+' ? current + step : current - step, 0, limit)
  }
  const absolute = Number(adjustment.replace('%', ''))
  if (Number.isFinite(absolute)) return clamp(adjustment.endsWith('%') ? absolute / 100 : absolute, 0, limit)
  return current
}

export class FakeWpctl {
  volume = 0.6
  muted = false

  constructor(private readonly bus: PlaygroundBus) {}

  /**
   * Stands in for `child_process.spawn` in runVolumeCommand. Only the `error`
   * and `exit` events are consumed, so the fake child emits an immediate clean
   * exit; the cast keeps the pretence to this one line.
   */
  readonly spawnProcess = ((file: string, args: readonly string[]) => {
    const child = new EventEmitter()
    this.run(file, [...args])
    queueMicrotask(() => child.emit('exit', 0, null))
    return child as unknown as ChildProcess
  }) as unknown as typeof spawn

  /** Stands in for the execFile the output monitor polls with. */
  readonly execute: CommandRunner = async (file, args) => ({ stdout: this.run(file, args), stderr: '' })

  private run(file: string, args: string[]): string {
    const verb = args[0] ?? ''
    if (verb === 'get-volume') {
      // The poll runs every second; logging it would bury everything else.
      return `Volume: ${this.volume.toFixed(2)}${this.muted ? ' [MUTED]' : ''}\n`
    }
    this.bus.log('wpctl', 'out', `${file} ${args.join(' ')}`)
    if (verb === 'set-volume') {
      const limitIndex = args.indexOf('-l')
      const limit = limitIndex >= 0 ? Number(args[limitIndex + 1] ?? 1) : 1
      const adjustment = args[args.length - 1] ?? ''
      this.volume = applyAdjustment(this.volume, adjustment, Number.isFinite(limit) ? limit : 1)
      this.bus.log('wpctl', 'note', `sink volume is now ${Math.round(this.volume * 100)}%`)
    } else if (verb === 'set-mute') {
      const state = args[args.length - 1] ?? ''
      this.muted = state === 'toggle' ? !this.muted : state === '1'
      this.bus.log('wpctl', 'note', `sink is ${this.muted ? 'muted' : 'unmuted'}`)
    } else {
      this.bus.log('wpctl', 'note', `unsupported wpctl verb "${verb}"`)
    }
    return ''
  }
}
