import assert from 'node:assert/strict'
import test from 'node:test'
import type { StreamDeck } from '@elgato-stream-deck/node'

import { ControlModel, createState } from '../../src/state.mjs'
import type { Binding } from '../../src/streamdeck/bindings.mjs'
import { createImage } from '../../src/streamdeck/bitmap.mjs'
import type { StreamDeckLayout } from '../../src/streamdeck/grid.mjs'
import { DeckRenderer, dialDetail } from '../../src/streamdeck/renderer.mjs'
import { ActionTile } from '../../src/streamdeck/tiles/action-tile.mjs'
import type { Tile, TileHost } from '../../src/streamdeck/tiles/tile.mjs'
import { testContext } from '../support/fixtures.mjs'
import type { Action, Bitmap } from '../../src/types.mjs'

const rendererFor = (layout: StreamDeckLayout): DeckRenderer =>
  new DeckRenderer({ layout, model: new ControlModel(createState(), () => ({ sources: {} })) })

/** A dial binding whose behaviour is irrelevant; only its action is read. */
const bound = (action: Action): Binding => ({ action, run: () => {} })

test('dial readouts follow their bound actions rather than dial position', () => {
  const state = createState({ volume: 0.67 })
  const volumeDial = {
    label: 'VOLUME',
    left: bound({ type: 'audio', command: 'down' }),
    right: bound({ type: 'audio', command: 'up' }),
    press: bound({ type: 'audio', command: 'mute' }),
  }

  // The volume dial reports volume wherever it sits in the layout.
  assert.equal(dialDetail(testContext(state), volumeDial), '67%')
  state.outputMuted = true
  assert.equal(dialDetail(testContext(state), volumeDial), 'MUTED')

  assert.equal(dialDetail(testContext(state, { sources: { aux: true } }), {
    label: 'AUX',
    press: bound({ type: 'audio', source: 'aux', command: 'toggle' }),
  }), 'ON')
  assert.equal(dialDetail(testContext(state, { sources: { usb: false } }), {
    label: 'USB',
    left: bound({ type: 'audio', source: 'usb', command: 'off' }),
  }), 'OFF')

  // A dial bound to neither volume nor a route falls back to the assist state.
  assert.equal(dialDetail(testContext(createState({ assist: 'LISTENING' })), {
    label: 'VOICE',
    press: bound({ type: 'lva', command: 'start_listening' }),
  }), 'LISTENING')
})

test('a dial that supplies its own readout wins over the bound actions', () => {
  // A light dial is bound to `ha` actions the shared readout cannot interpret,
  // so it reports brightness itself — the dial equivalent of a tile drawing its
  // own face.
  const lights = {
    label: 'LIGHTS',
    press: bound({ type: 'ha', command: 'toggle', entity: 'light.office' }),
    detail: () => '60%',
  }
  assert.equal(dialDetail(testContext(), lights), '60%')

  // An own readout also overrides one the actions would have produced.
  assert.equal(dialDetail(testContext(createState({ volume: 0.2 })), {
    ...lights,
    left: bound({ type: 'audio', command: 'down' }),
  }), '60%')
})

/** A tile that records its label when pressed, to see which slot dispatched. */
const recorder = (label: string, presses: string[]): ActionTile =>
  new ActionTile({ label, color: '#000000', binding: { action: { type: 'noop' }, run: () => presses.push(label) } })

test('a multi-page layout maps the grid around the two nav corners', () => {
  const presses: string[] = []
  const tile = (label: string): ActionTile => recorder(label, presses)
  const renderer = rendererFor({
    brightness: 40,
    dials: [],
    pages: [
      {
        name: 'ONE',
        grid: {
          topLeft: tile('A'),
          topMidLeft: tile('B'),
          topMidRight: tile('C'),
          topRight: tile('D'),
          bottomLeft: tile('E'),
          bottomRight: tile('F'),
        },
      },
      { name: 'TWO', grid: { topLeft: tile('G') } },
    ],
  })

  // The bottom corners navigate; the other six slots carry the page's tiles.
  assert.equal(renderer.navTarget(4), 'prev')
  assert.equal(renderer.navTarget(7), 'next')
  assert.equal(renderer.navTarget(0), undefined)
  assert.equal(renderer.pressAt(4), undefined, 'nav corners dispatch nothing')
  assert.equal(renderer.pressAt(7), undefined)

  // Physical slots 0-3 then the two inner bottom keys 5,6 hold the six tiles.
  for (const slot of [0, 1, 2, 3, 5, 6]) renderer.pressAt(slot)?.()
  assert.deepEqual(presses, ['A', 'B', 'C', 'D', 'E', 'F'])

  // Next wraps forward to page TWO, whose single tile lands in the first slot.
  renderer.changePage(1)
  renderer.pressAt(0)?.()
  assert.deepEqual(presses.at(-1), 'G')
  assert.equal(renderer.pressAt(1), undefined, 'the rest of page TWO is blank')

  // Previous wraps back around to page ONE.
  renderer.changePage(-1)
  renderer.pressAt(6)?.()
  assert.deepEqual(presses.at(-1), 'F')
})

test('a single-page layout offers no navigation and reserves no corners', () => {
  const presses: string[] = []
  const renderer = rendererFor({
    brightness: 40,
    dials: [],
    pages: [{ name: 'ONE', grid: { topLeft: recorder('A', presses) } }],
  })

  assert.equal(renderer.navTarget(4), undefined, 'no paging without a second page')
  assert.equal(renderer.navTarget(7), undefined)
  renderer.pressAt(0)?.()
  assert.deepEqual(presses, ['A'])
})

/** A lifecycle probe: records mounts and unmounts, and can poke its host. */
class ProbeTile implements Tile {
  private host: TileHost | null = null

  constructor(private readonly label: string, private readonly log: string[]) {}

  press(): void {}

  render(): Bitmap {
    return createImage(120, 120, '#000000')
  }

  mount(host: TileHost): void {
    this.log.push(`mount:${this.label}`)
    this.host = host
  }

  unmount(): void {
    this.log.push(`unmount:${this.label}`)
    this.host = null
  }

  poke(): void {
    this.host?.invalidate()
  }
}

test('tiles are mounted while visible on an attached deck and can repaint their key', () => {
  const log: string[] = []
  const one = new ProbeTile('A', log)
  const two = new ProbeTile('G', log)
  const renderer = rendererFor({
    brightness: 40,
    dials: [],
    pages: [
      { name: 'ONE', grid: { topLeft: one } },
      { name: 'TWO', grid: { topLeft: two } },
    ],
  })

  // Without a deck nothing mounts, so LED-only deployments never start timers.
  one.poke()
  assert.deepEqual(log, [])

  const painted: number[] = []
  const deck = {
    fillKeyBuffer: async (index: number) => { painted.push(index) },
    fillLcd: async () => {},
  } as unknown as StreamDeck
  renderer.setDeck(deck)
  assert.deepEqual(log, ['mount:A'])

  // A mounted tile repaints just its own key, outside the shared schedule.
  one.poke()
  assert.deepEqual(painted, [0])

  // Paging away swaps which page's tiles are live.
  renderer.changePage(1)
  assert.deepEqual(log, ['mount:A', 'unmount:A', 'mount:G'])

  // Losing the deck unmounts everything; a stale poke touches nothing.
  renderer.clearDeck(deck)
  assert.deepEqual(log, ['mount:A', 'unmount:A', 'mount:G', 'unmount:G'])
  const afterUnmount = painted.length
  two.poke()
  assert.equal(painted.length, afterUnmount)
})
