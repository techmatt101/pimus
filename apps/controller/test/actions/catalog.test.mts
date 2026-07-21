import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  describeActionProblem,
  indicatorFor,
  runHaCommand,
  runVoiceCommand,
  HA_ACTIONS,
  ROUTE_ACTIONS,
  VOICE_ACTIONS,
  VOLUME_ACTIONS,
  type VoiceContext,
} from '../../src/actions/catalog.mjs'
import { createState } from '../../src/state.mjs'

test('valid actions from the catalog pass configuration validation', () => {
  const valid: unknown[] = [
    undefined,
    { type: 'noop' },
    ...Object.keys(VOICE_ACTIONS).map((command) => ({ type: 'lva', command })),
    ...Object.keys(VOLUME_ACTIONS).map((command) => ({ type: 'audio', command })),
    ...Object.keys(ROUTE_ACTIONS).map((command) => ({ type: 'audio', source: 'aux', command })),
    ...Object.keys(HA_ACTIONS).map((command) => ({ type: 'ha', command, entity: 'light.office' })),
    { type: 'lva', command: 'some_future_lva_command' },
    { type: 'webhook', id: 'office_lights' },
  ]
  for (const action of valid) {
    assert.equal(describeActionProblem(action), null, `rejected ${JSON.stringify(action)}`)
  }
})

test('mistyped actions are rejected with an actionable message', () => {
  assert.match(String(describeActionProblem({ type: 'audio', command: 'sideways' })), /unknown volume command/)
  assert.match(
    String(describeActionProblem({ type: 'audio', source: 'aux', command: 'sideways' })),
    /unknown route command/,
  )
  assert.match(String(describeActionProblem({ type: 'audio' })), /needs a command/)
  assert.match(String(describeActionProblem({ type: 'lva' })), /needs a command/)
  assert.match(String(describeActionProblem({ type: 'webhook' })), /needs an id/)
  assert.match(
    String(describeActionProblem({ type: 'ha', command: 'levitate', entity: 'fan.office' })),
    /unknown Home Assistant command/,
  )
  // A key bound to a mistyped entity id would press successfully and reach
  // nothing, so the id has to be checked as strictly as the command.
  assert.match(String(describeActionProblem({ type: 'ha', command: 'toggle' })), /needs an entity id/)
  assert.match(
    String(describeActionProblem({ type: 'ha', command: 'toggle', entity: 'office_ceiling' })),
    /needs an entity id/,
  )
  assert.match(String(describeActionProblem({ type: 'lights' })), /unknown action type/)
  assert.match(String(describeActionProblem('mute')), /must be an object/)
})

test('every catalogued Home Assistant action calls a service', () => {
  for (const command of Object.keys(HA_ACTIONS) as Array<keyof typeof HA_ACTIONS>) {
    const calls: string[] = []
    runHaCommand(command, {
      entity: 'light.office',
      data: { duration: '00:05:00' },
      ha: {
        connected: true,
        entity: () => undefined,
        watch: () => () => {},
        call: (domain, service) => calls.push(`${domain}.${service}`),
      },
    })
    assert.ok(calls.length > 0, `${command} called no service`)
  }
})

test('every catalogued voice action reaches the LVA socket', () => {
  for (const command of Object.keys(VOICE_ACTIONS)) {
    const sent: string[] = []
    runVoiceCommand(command, {
      state: createState(),
      lva: { send: (lvaCommand) => { sent.push(lvaCommand) } },
      onStateChange: () => {},
    })
    assert.ok(sent.length > 0, `${command} sent nothing to LVA`)
  }
})

test('voice runners keep local state in step with what they send', () => {
  const state = createState({ muted: false, media: true })
  const sent: string[] = []
  let changes = 0
  const context: VoiceContext = {
    state,
    lva: { send: (command) => { sent.push(command) } },
    onStateChange: () => { changes += 1 },
  }

  runVoiceCommand('mute_toggle', context)
  runVoiceCommand('stop', context)
  // A command with no catalog entry is forwarded to LVA unchanged.
  runVoiceCommand('some_future_lva_command', context)

  assert.deepEqual(sent, [
    'mute_mic',
    'stop_timer_ringing',
    'stop_pipeline',
    'stop_media_player',
    'some_future_lva_command',
  ])
  assert.equal(state.media, false)
  assert.equal(changes, 1)
})

test('only actions that report a live state expose an indicator', () => {
  assert.ok(indicatorFor({ type: 'lva', command: 'mute_toggle' }))
  assert.ok(indicatorFor({ type: 'audio', source: 'aux', command: 'toggle' }))
  // A plain command, a master volume action, and a webhook have nothing to show.
  assert.equal(indicatorFor({ type: 'lva', command: 'stop' }), undefined)
  assert.equal(indicatorFor({ type: 'audio', command: 'up' }), undefined)
  assert.equal(indicatorFor({ type: 'webhook', id: 'lights' }), undefined)
  assert.equal(indicatorFor(undefined), undefined)
})

/** Walks up from the compiled test to the repository root. */
function findRepositoryFile(relativePath: string): string {
  let directory = path.dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 10; depth += 1) {
    const candidate = path.join(directory, relativePath)
    if (fs.existsSync(candidate)) return candidate
    directory = path.dirname(directory)
  }
  throw new Error(`could not locate ${relativePath} from the compiled tests`)
}

test('docs/controls.md documents every catalogued action', () => {
  const reference = fs.readFileSync(findRepositoryFile('docs/controls.md'), 'utf8')
  const documented = [
    ...Object.keys(VOICE_ACTIONS),
    ...Object.keys(VOLUME_ACTIONS),
    ...Object.keys(ROUTE_ACTIONS),
    ...Object.keys(HA_ACTIONS),
  ]
  for (const command of documented) {
    assert.ok(
      reference.includes(`\`${command}\``),
      `docs/controls.md is missing the "${command}" action`,
    )
  }
})
