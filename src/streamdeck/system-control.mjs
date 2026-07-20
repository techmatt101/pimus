import fs from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export function readAudioState(path) {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'))
  } catch {
    return { sources: {} }
  }
}

export function runSmartampctl(args, { onExit = () => {}, spawnProcess = spawn } = {}) {
  const child = spawnProcess('/usr/local/bin/smartampctl', args, { stdio: 'inherit' })
  child.on('exit', onExit)
  return child
}

export function parseOutputState(output) {
  const match = output.match(/Volume:\s+([0-9.]+)/)
  return {
    volume: match ? Number(match[1]) : undefined,
    outputMuted: output.includes('[MUTED]'),
  }
}

export function startOutputMonitor({
  state,
  onStateChange = () => {},
  intervalMilliseconds = 1000,
  execute = execFileAsync,
}) {
  const poll = async () => {
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
  const timer = setInterval(poll, intervalMilliseconds)
  return () => clearInterval(timer)
}
