import assert from 'node:assert/strict'
import test from 'node:test'

import { createState } from '../../src/state.mjs'
import type { StreamDeckLayout } from '../../src/streamdeck/grid.mjs'
import { DeckRenderer, dialDetail } from '../../src/streamdeck/renderer.mjs'
import { ActionTile } from '../../src/streamdeck/tile.mjs'

const rendererFor = (layout: StreamDeckLayout): DeckRenderer =>
  new DeckRenderer({ layout, state: createState(), readAudioState: () => ({ sources: {} }) })

const noop = (label: string): ActionTile => new ActionTile({ label, color: '#000000', action: { type: 'noop' } })

test('dial readouts follow their bound actions rather than dial position', () => {
  const state = createState({ volume: 0.67 })
  const volumeDial = {
    label: 'VOLUME',
    left: { type: 'audio', command: 'down' },
    right: { type: 'audio', command: 'up' },
    press: { type: 'audio', command: 'mute' },
  } as const

  // The volume dial reports volume wherever it sits in the layout.
  assert.equal(dialDetail(state, { sources: {} }, volumeDial), '67%')
  state.outputMuted = true
  assert.equal(dialDetail(state, { sources: {} }, volumeDial), 'MUTED')

  assert.equal(dialDetail(state, { sources: { aux: true } }, {
    label: 'AUX',
    press: { type: 'audio', source: 'aux', command: 'toggle' },
  }), 'ON')
  assert.equal(dialDetail(state, { sources: { usb: false } }, {
    label: 'USB',
    left: { type: 'audio', source: 'usb', command: 'off' },
  }), 'OFF')

  // A dial bound to neither volume nor a route falls back to the assist state.
  assert.equal(dialDetail(createState({ assist: 'LISTENING' }), { sources: {} }, {
    label: 'VOICE',
    press: { type: 'lva', command: 'start_listening' },
  }), 'LISTENING')
})

test('a multi-page layout maps the grid around the two nav corners', () => {
  const renderer = rendererFor({
    brightness: 40,
    dials: [],
    pages: [
      {
        name: 'ONE',
        grid: {
          topLeft: noop('A'),
          topMidLeft: noop('B'),
          topMidRight: noop('C'),
          topRight: noop('D'),
          bottomLeft: noop('E'),
          bottomRight: noop('F'),
        },
      },
      { name: 'TWO', grid: { topLeft: noop('G') } },
    ],
  })

  // The bottom corners navigate; the other six slots carry the page's tiles.
  assert.equal(renderer.navTarget(4), 'prev')
  assert.equal(renderer.navTarget(7), 'next')
  assert.equal(renderer.navTarget(0), undefined)
  assert.equal(renderer.actionAt(4), undefined, 'nav corners dispatch nothing')
  assert.equal(renderer.actionAt(7), undefined)

  // Physical slots 0-3 then the two inner bottom keys 5,6 hold the six tiles.
  for (const slot of [0, 1, 2, 3, 5, 6]) {
    assert.deepEqual(renderer.actionAt(slot), { type: 'noop' }, `slot ${slot} dispatches its tile`)
  }

  // Next wraps forward to page TWO, whose single tile lands in the first slot.
  renderer.changePage(1)
  assert.deepEqual(renderer.actionAt(0), { type: 'noop' })
  assert.equal(renderer.actionAt(1), undefined, 'the rest of page TWO is blank')

  // Previous wraps back around to page ONE.
  renderer.changePage(-1)
  assert.deepEqual(renderer.actionAt(6), { type: 'noop' })
})

test('a single-page layout offers no navigation and reserves no corners', () => {
  const renderer = rendererFor({
    brightness: 40,
    dials: [],
    pages: [{ name: 'ONE', grid: { topLeft: noop('A') } }],
  })

  assert.equal(renderer.navTarget(4), undefined, 'no paging without a second page')
  assert.equal(renderer.navTarget(7), undefined)
  assert.deepEqual(renderer.actionAt(0), { type: 'noop' })
})
