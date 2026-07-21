import assert from 'node:assert/strict'
import test from 'node:test'

import { createState } from '../../src/state.mjs'
import { ActionTile, MediaTile, actionAppearance } from '../../src/streamdeck/tile.mjs'
import type { TileContext } from '../../src/streamdeck/tile.mjs'
import type { ControlState } from '../../src/types.mjs'

const context = (state: ControlState = createState(), sources: Record<string, boolean> = {}): TileContext =>
  ({ state, audio: { sources } })

test('an action tile takes its face from the bound action catalog indicator', () => {
  const aux = { label: 'AUX', color: '#4a148c', action: { type: 'audio', source: 'aux', command: 'toggle' } } as const
  assert.deepEqual(actionAppearance(aux, context(createState(), { aux: true })), {
    label: 'AUX ON',
    background: '#1b5e20',
  })
  assert.deepEqual(actionAppearance(aux, context()), { label: 'AUX OFF', background: '#4a148c' })

  const mic = { label: 'MIC', color: '#000000', action: { type: 'lva', command: 'mute_toggle' } } as const
  assert.deepEqual(actionAppearance(mic, context(createState({ muted: true }))), {
    label: 'MIC OFF',
    background: '#d50000',
  })

  // An action with no indicator keeps exactly what the layout configured.
  const lights = { label: 'LIGHTS', color: '#333333', action: { type: 'webhook', id: 'office_lights' } } as const
  assert.deepEqual(actionAppearance(lights, context()), { label: 'LIGHTS', background: '#333333' })
})

test('an action tile dispatches its configured action and paints a key face', () => {
  const tile = new ActionTile({ label: 'STOP', color: '#b71c1c', action: { type: 'lva', command: 'stop' } })
  assert.deepEqual(tile.action(), { type: 'lva', command: 'stop' })

  const face = tile.render(context())
  assert.equal(face.width, 120)
  assert.equal(face.height, 120)
})

test('the media tile is one play/pause button that repaints itself by playback state', () => {
  const tile = new MediaTile()
  // A single action toggles the player whichever way it is currently facing.
  assert.deepEqual(tile.action(), { type: 'lva', command: 'media_toggle' })

  const playing = tile.render(context(createState({ media: true }))).buffer
  const paused = tile.render(context(createState({ media: false }))).buffer
  assert.notDeepEqual(playing, paused, 'the play and pause faces differ')
})
