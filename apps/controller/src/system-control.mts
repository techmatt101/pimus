import fs from 'node:fs'
import path from 'node:path'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'

import type { AudioState, ControlState } from './types.mjs'

const execFileAsync = promisify(execFile)

const lockWait = new Int32Array(new SharedArrayBuffer(4))

/**
 * The audio manager also reads and rewrites the audio state file, so writes
 * use the same .lock-directory protocol as the Python side: atomic mkdir,
 * 30 s stale-lock recovery, unique temp file, rename.
 */
function withStateLock<T>(stateFile: string, callback: () => T): T {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true })
  const lockPath = `${stateFile}.lock`
  const deadline = Date.now() + 2000
  while (true) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 })
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > 30_000) {
          fs.rmdirSync(lockPath)
          continue
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw statError
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for state lock ${lockPath}`)
      Atomics.wait(lockWait, 0, 0, 10)
    }
  }
  try {
    return callback()
  } finally {
    try { fs.rmdirSync(lockPath) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

function writeFileAtomic(stateFile: string, serialized: string): void {
  const temporary = `${stateFile}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  try {
    const descriptor = fs.openSync(temporary, 'wx', 0o640)
    try {
      fs.writeFileSync(descriptor, serialized)
      fs.fsyncSync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
    fs.renameSync(temporary, stateFile)
  } finally {
    try { fs.unlinkSync(temporary) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

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

/**
 * Applies an on/off/toggle command to a named route in the shared audio state
 * file. The audio manager reconciles PipeWire loopbacks from this file on its
 * next poll; returns the route's new desired state.
 */
export function setSourceState(stateFile: string, name: string, command: string): boolean {
  return withStateLock(stateFile, () => {
    const current = readAudioState(stateFile)
    const enabled = command === 'toggle' ? !current.sources[name] : command === 'on'
    if (current.sources[name] !== enabled) {
      const next: AudioState = { ...current, sources: { ...current.sources, [name]: enabled } }
      writeFileAtomic(stateFile, `${JSON.stringify(next, null, 2)}\n`)
    }
    return enabled
  })
}

// Volume goes straight to the PipeWire default sink; -l 1.0 caps "up" at 100%.
const VOLUME_OPERATIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  up: ['set-volume', '-l', '1.0', '@DEFAULT_AUDIO_SINK@', '5%+'],
  down: ['set-volume', '@DEFAULT_AUDIO_SINK@', '5%-'],
  mute: ['set-mute', '@DEFAULT_AUDIO_SINK@', 'toggle'],
})

export interface VolumeCommandOptions {
  onExit?: () => void
  spawnProcess?: typeof spawn
  logger?: Pick<Console, 'error'>
}

export function runVolumeCommand(
  command: string,
  { onExit = () => {}, spawnProcess = spawn, logger = console }: VolumeCommandOptions = {},
): ChildProcess | null {
  const args = VOLUME_OPERATIONS[command]
  if (!args) {
    logger.error(`unknown volume command ${command}`)
    return null
  }
  const child = spawnProcess('wpctl', [...args], { stdio: 'inherit' })
  let finished = false
  const finish = (): void => {
    if (finished) return
    finished = true
    onExit()
  }
  child.on('error', (error) => {
    logger.error(`wpctl volume ${command} failed to start`, error)
    finish()
  })
  child.on('exit', (code, signal) => {
    if (code !== 0) {
      logger.error(`wpctl volume ${command} exited ${code ?? `after ${signal}`}`)
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
