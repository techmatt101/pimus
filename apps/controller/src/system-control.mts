import fs from 'node:fs'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'

import type { AudioState, ControlState } from './types.mjs'

const execFileAsync = promisify(execFile)

export type CommandRunner = (
  file: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>

export function readAudioState(path: string): AudioState {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(path, 'utf8'))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { sources: {} }
    const sources = (value as { sources?: unknown }).sources
    if (typeof sources !== 'object' || sources === null || Array.isArray(sources)) return { sources: {} }
    return value as AudioState
  } catch {
    return { sources: {} }
  }
}

export interface SmartampctlOptions {
  onExit?: () => void
  spawnProcess?: typeof spawn
  logger?: Pick<Console, 'error'>
}

export function runSmartampctl(
  args: string[],
  { onExit = () => {}, spawnProcess = spawn, logger = console }: SmartampctlOptions = {},
): ChildProcess {
  const child = spawnProcess('/usr/local/bin/smartampctl', args, { stdio: 'inherit' })
  let finished = false
  const finish = (): void => {
    if (finished) return
    finished = true
    onExit()
  }
  child.on('error', (error) => {
    logger.error(`smartampctl ${args.join(' ')} failed to start`, error)
    finish()
  })
  child.on('exit', (code, signal) => {
    if (code !== 0) {
      logger.error(`smartampctl ${args.join(' ')} exited ${code ?? `after ${signal}`}`)
    }
    finish()
  })
  return child
}

export function parseOutputState(output: string): {
  volume: number | undefined
  outputMuted: boolean
} {
  const match = output.match(/Volume:\s+([0-9.]+)/)
  const volume = match?.[1]
  return {
    volume: volume === undefined ? undefined : Number(volume),
    outputMuted: output.includes('[MUTED]'),
  }
}

export interface OutputMonitorOptions {
  state: ControlState
  onStateChange?: () => void
  intervalMilliseconds?: number
  execute?: CommandRunner
}

/** Polls PipeWire for the default sink volume; returns a stop function. */
export function startOutputMonitor({
  state,
  onStateChange = () => {},
  intervalMilliseconds = 1000,
  execute = execFileAsync as CommandRunner,
}: OutputMonitorOptions): () => void {
  const poll = async (): Promise<void> => {
    try {
      const { stdout } = await execute('wpctl', ['get-volume', '@DEFAULT_AUDIO_SINK@'])
      const output = parseOutputState(stdout)
      if (output.volume !== undefined) state.volume = output.volume
      state.outputMuted = output.outputMuted
      onStateChange()
    } catch {
      // PipeWire may still be starting; the next interval retries automatically.
    }
  }
  void poll()
  const timer = setInterval(() => void poll(), intervalMilliseconds)
  return () => clearInterval(timer)
}
