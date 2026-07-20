import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { parseOutputState, runVolumeCommand } from '../../src/audio/volume.mjs'
import type { ChildProcess, spawn } from 'node:child_process'

test('volume commands run wpctl directly and log failures', () => {
  const spawned: [string, string[]][] = []
  const child = new EventEmitter() as ChildProcess
  const errors: unknown[][] = []
  let exits = 0
  runVolumeCommand('up', {
    spawnProcess: ((file: string, args: string[]) => {
      spawned.push([file, args])
      return child
    }) as unknown as typeof spawn,
    onExit: () => { exits += 1 },
    logger: { error: (...args: unknown[]) => { errors.push(args) } },
  })
  assert.deepEqual(spawned, [['wpctl', ['set-volume', '-l', '1.0', '@DEFAULT_AUDIO_SINK@', '5%+']]])
  child.emit('error', new Error('spawn failed'))
  child.emit('exit', 1, null)
  assert.equal(exits, 1)
  assert.equal(errors.length, 2)
  assert.match(String(errors[0]?.[0]), /failed to start/)
  assert.match(String(errors[1]?.[0]), /exited 1/)

  assert.equal(runVolumeCommand('sideways', {
    spawnProcess: (() => child) as typeof spawn,
    logger: { error: () => {} },
  }), null)
})

test('PipeWire volume output parses into display state', () => {
  assert.deepEqual(parseOutputState('Volume: 0.55 [MUTED]'), { volume: 0.55, outputMuted: true })
  assert.deepEqual(parseOutputState('Volume: 1.00'), { volume: 1, outputMuted: false })
})
