import {type ChildProcess, execFile, spawn} from 'node:child_process'
import {promisify} from 'node:util'

import type {ControlState} from '../types.mjs'

const execFileAsync = promisify(execFile)

export type CommandRunner = (
    file: string,
    args: string[],
) => Promise<{ stdout: string; stderr: string }>

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
    {
        onExit = () => {
        }, spawnProcess = spawn, logger = console
    }: VolumeCommandOptions = {},
): ChildProcess | null {
    const args = VOLUME_OPERATIONS[command]
    if (!args) {
        logger.error(`unknown volume command ${command}`)
        return null
    }
    const child = spawnProcess('wpctl', [...args], {stdio: 'inherit'})
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
                                       onStateChange = () => {
                                       },
                                       intervalMilliseconds = 1000,
                                       execute = execFileAsync as CommandRunner,
                                   }: OutputMonitorOptions): () => void {
    const poll = async (): Promise<void> => {
        try {
            const {stdout} = await execute('wpctl', ['get-volume', '@DEFAULT_AUDIO_SINK@'])
            const output = parseOutputState(stdout)
            const changed =
                (output.volume !== undefined && output.volume !== state.volume)
                || output.outputMuted !== state.outputMuted
            if (output.volume !== undefined) state.volume = output.volume
            state.outputMuted = output.outputMuted
            if (changed) onStateChange()
        } catch {
            // PipeWire may still be starting; the next interval retries automatically.
        }
    }
    void poll()
    const timer = setInterval(() => void poll(), intervalMilliseconds)
    return () => clearInterval(timer)
}
