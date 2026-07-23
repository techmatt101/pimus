import assert from 'node:assert/strict'
import test from 'node:test'

import { createState } from '../../../src/state.mjs'
import type { Binding } from '../../../src/streamdeck/bindings.mjs'
import { ActionTile, actionAppearance } from '../../../src/streamdeck/tiles/action-tile.mjs'
import type { TileContext } from '../../../src/streamdeck/tiles/tile.mjs'
import type { ControlState } from '../../../src/types.mjs'
import { tileFace } from '../../support/fixtures.mjs'

const context = (state: ControlState = createState(), sources: Record<string, boolean> = {}): TileContext =>
  ({ state, audio: { sources }, now: 0 })

const binding = (action: Binding['action']): Binding => ({ action, run: () => {} })

test('an action tile takes its face from the bound action catalog indicator', () => {
  const aux = { label: 'AUX', color: '#4a148c', binding: binding({ type: 'audio', source: 'aux', command: 'toggle' }) }
  assert.deepEqual(actionAppearance(aux, context(createState(), { aux: true })), {
    label: 'AUX ON',
    background: '#1b5e20',
  })
  assert.deepEqual(actionAppearance(aux, context()), { label: 'AUX OFF', background: '#4a148c' })

  const mic = { label: 'MIC', color: '#000000', binding: binding({ type: 'lva', command: 'mute_toggle' }) }
  assert.deepEqual(actionAppearance(mic, context(createState({ muted: true }))), {
    label: 'MIC OFF',
    background: '#d50000',
  })

  // An action with no indicator keeps exactly what the layout configured.
  const lights = { label: 'LIGHTS', color: '#333333', binding: binding({ type: 'ha', command: 'activate', entity: 'scene.office_bright' }) }
  assert.deepEqual(actionAppearance(lights, context()), { label: 'LIGHTS', background: '#333333' })
})

test('an action tile runs its own binding and paints a key face', () => {
  const presses: string[] = []
  const tile = new ActionTile({
    label: 'STOP',
    color: '#b71c1c',
    binding: { action: { type: 'lva', command: 'stop' }, run: () => presses.push('stop') },
  })
  assert.deepEqual(tile.action(), { type: 'lva', command: 'stop' })

  tile.press()
  assert.deepEqual(presses, ['stop'])

  const face = tileFace(tile, context())
  assert.equal(face.width, 120)
  assert.equal(face.height, 120)
})
