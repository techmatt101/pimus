import assert from 'node:assert/strict'
import test from 'node:test'
import type { StreamDeck } from '@elgato-stream-deck/node'

import { ControlModel, createState } from '../../src/state.mjs'
import type { StreamDeckLayout } from '../../src/streamdeck/grid.mjs'
import { DeckRenderer } from '../../src/streamdeck/renderer.mjs'
import { ActionTile } from '../../src/streamdeck/tiles/action-tile.mjs'
import type { Tile, TileHost } from '../../src/streamdeck/tiles/tile.mjs'
import type { Surface } from '../../src/streamdeck/surface.mjs'
import { testStrip } from '../support/fixtures.mjs'

/** A layout of keys alone; what the strip shows has its own test file. */
const rendererFor = (
  layout: Omit<StreamDeckLayout, 'strip'>,
  model = new ControlModel(createState(), () => ({ sources: {} })),
): DeckRenderer =>
  new DeckRenderer({
    layout: { ...layout, strip: testStrip(layout.dials) },
    model,
  })

/** Let every pending microtask of an async panel transition finish. */
const settle = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })

/** A tile that records its label when pressed, to see which slot dispatched. */
const recorder = (label: string, presses: string[]): ActionTile =>
  new ActionTile({ label, color: '#000000', binding: { action: { type: 'noop' }, run: () => presses.push(label) } })

test('the grid fills all eight slots and pages with changePage', () => {
  const presses: string[] = []
  const tile = (label: string): ActionTile => recorder(label, presses)
  const renderer = rendererFor({
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
          bottomMidLeft: tile('F'),
          bottomMidRight: tile('G'),
          bottomRight: tile('H'),
        },
      },
      { name: 'TWO', grid: { topLeft: tile('I') } },
    ],
  })

  // Every one of the eight keys carries a tile now that paging moved to a dial.
  for (const slot of [0, 1, 2, 3, 4, 5, 6, 7]) renderer.pressAt(slot)?.()
  assert.deepEqual(presses, ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'])

  // changePage wraps forward to page TWO, whose single tile lands in the first slot.
  renderer.changePage(1)
  assert.equal(renderer.currentName(), 'TWO', 'the page dial reads out where it landed')
  renderer.pressAt(0)?.()
  assert.deepEqual(presses.at(-1), 'I')
  assert.equal(renderer.pressAt(1), undefined, 'the rest of page TWO is blank')

  // ...and wraps back around to page ONE, including its bottom corners.
  renderer.changePage(-1)
  assert.equal(renderer.currentName(), 'ONE')
  renderer.pressAt(7)?.()
  assert.deepEqual(presses.at(-1), 'H')
})

test('a single-page layout stays on its one page when the dial is turned', () => {
  const presses: string[] = []
  const renderer = rendererFor({
    dials: [],
    pages: [{ name: 'ONE', grid: { topLeft: recorder('A', presses), bottomRight: recorder('Z', presses) } }],
  })

  // Both corners are ordinary keys now, so a single page can use all of them.
  renderer.pressAt(0)?.()
  renderer.pressAt(7)?.()
  assert.deepEqual(presses, ['A', 'Z'])

  // One page: paging the dial wraps harmlessly back to the same page.
  renderer.changePage(1)
  assert.equal(renderer.currentName(), 'ONE')
})

/** A lifecycle probe: records mounts and unmounts, and can poke its host. */
class ProbeTile implements Tile {
  private host: TileHost | null = null

  constructor(private readonly label: string, private readonly log: string[]) {}

  press(): void {}

  draw(surface: Surface): void {
    surface.fill('#000000')
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

test('tiles are mounted while visible on an attached deck and can repaint their key', async () => {
  const log: string[] = []
  const one = new ProbeTile('A', log)
  const two = new ProbeTile('G', log)
  const renderer = rendererFor({
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
    setBrightness: async () => {},
  } as unknown as StreamDeck
  await renderer.setDeck(deck)
  assert.deepEqual(log, ['mount:A'])
  painted.length = 0

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

test('a sleeping panel goes dark, stops every tile, and comes back painted', async () => {
  const log: string[] = []
  const tile = new ProbeTile('A', log)
  const model = new ControlModel(createState(), () => ({ sources: {} }))
  const renderer = rendererFor({
    dials: [],
    pages: [{ name: 'ONE', grid: { topLeft: tile } }],
  }, model)

  const painted: number[] = []
  const brightness: number[] = []
  const deck = {
    fillKeyBuffer: async (index: number) => { painted.push(index) },
    fillLcd: async () => {},
    setBrightness: async (level: number) => { brightness.push(level) },
  } as unknown as StreamDeck
  await renderer.setDeck(deck)
  assert.deepEqual(brightness, [40], 'an attached deck comes up at the default brightness')
  assert.deepEqual(log, ['mount:A'])

  // The room emptied. The panel switches off, then the tiles are dropped, so
  // their animation timers and entity watchers stop with it.
  model.state.awake = false
  model.notify()
  await settle()
  assert.deepEqual(brightness, [40, 0])
  assert.deepEqual(log, ['mount:A', 'unmount:A'])

  // Nothing is written to a dark panel, whether by a stale timer or a state change.
  painted.length = 0
  tile.poke()
  model.notify()
  await renderer.render()
  assert.deepEqual(painted, [])

  // Waking paints first and only then brings the panel up: the deck retains its
  // last image, so raising the brightness onto it would flash the old room.
  model.state.awake = true
  model.notify()
  await settle()
  assert.deepEqual(log, ['mount:A', 'unmount:A', 'mount:A'])
  assert.ok(painted.length >= 8, 'the whole panel was repainted before it lit')
  assert.deepEqual(brightness, [40, 0, 40])
})

test('a brightness change while awake re-lights the panel, and only when it changes', async () => {
  const model = new ControlModel(createState(), () => ({ sources: {} }))
  const renderer = rendererFor({
    dials: [],
    pages: [{ name: 'ONE', grid: { topLeft: recorder('A', []) } }],
  }, model)

  const brightness: number[] = []
  const deck = {
    fillKeyBuffer: async () => {},
    fillLcd: async () => {},
    setBrightness: async (level: number) => { brightness.push(level) },
  } as unknown as StreamDeck
  await renderer.setDeck(deck)
  assert.deepEqual(brightness, [40])

  // A BrightnessTile press mutates the model and notifies; the panel follows.
  model.state.brightness = 100
  model.notify()
  await settle()
  assert.deepEqual(brightness, [40, 100])

  // A notify that leaves brightness alone does not re-issue the same level.
  model.notify()
  await settle()
  assert.deepEqual(brightness, [40, 100], 'unchanged brightness is not re-written')
})

test('a deck that reconnects while the room is empty comes back dark', async () => {
  const log: string[] = []
  const model = new ControlModel(createState({ awake: false }), () => ({ sources: {} }))
  const renderer = rendererFor({
    dials: [],
    pages: [{ name: 'ONE', grid: { topLeft: new ProbeTile('A', log) } }],
  }, model)

  const brightness: number[] = []
  const deck = {
    fillKeyBuffer: async () => { assert.fail('a sleeping panel is not painted') },
    fillLcd: async () => { assert.fail('a sleeping panel is not painted') },
    setBrightness: async (level: number) => { brightness.push(level) },
  } as unknown as StreamDeck
  await renderer.setDeck(deck)

  assert.deepEqual(brightness, [0])
  assert.deepEqual(log, [], 'no tile is mounted for a panel nobody can see')
})
