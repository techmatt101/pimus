import assert from 'node:assert/strict'
import test from 'node:test'

import { describeActionProblem } from '../../src/actions/catalog.mjs'
import { ControlModel, createState } from '../../src/state.mjs'
import type { TileServices } from '../../src/streamdeck/bindings.mjs'
import { createLayout } from '../../src/streamdeck/layout.mjs'
import type { TileContext } from '../../src/streamdeck/tiles/tile.mjs'

const CONTEXT: TileContext = { state: createState(), audio: { sources: {} }, now: 0 }

const testServices = (): TileServices & { calls: string[] } => {
  const calls: string[] = []
  return {
    calls,
    model: new ControlModel(createState()),
    lva: { send: (command) => { calls.push(`lva:${command}`) } },
    setSource: (name, command) => calls.push(`source:${name}:${command}`),
    setVolume: (command) => calls.push(`volume:${command}`),
  }
}

test('the compiled layout fits the Stream Deck+ hardware', () => {
  const layout = createLayout(testServices())
  assert.ok(layout.pages.length >= 1, 'at least one page')
  // The fixed grid caps each page at six slots; only the naming needs asserting.
  for (const page of layout.pages) {
    assert.ok(page.name.length > 0, `page ${page.name} is named for the nav keys`)
  }
  assert.ok(layout.dials.length <= 4, 'the deck has 4 dials')
  const brightness = layout.brightness
  assert.ok(brightness >= 0 && brightness <= 100, 'brightness is a percentage')
})

test('every bound action is understood by the catalog', () => {
  const layout = createLayout(testServices())
  const problems: string[] = []
  const check = (action: unknown, where: string): void => {
    const problem = describeActionProblem(action)
    if (problem) problems.push(`${where}: ${problem}`)
  }

  layout.pages.forEach((page) => {
    for (const [slot, tile] of Object.entries(page.grid)) {
      if (tile) check(tile.action?.(), `${page.name} ${slot}`)
    }
  })
  layout.dials.forEach((dial, index) => {
    check(dial.left?.action, `dial ${index} (${dial.label}) left`)
    check(dial.right?.action, `dial ${index} (${dial.label}) right`)
    check(dial.press?.action, `dial ${index} (${dial.label}) press`)
  })

  assert.deepEqual(problems, [])
})

test('layout tiles and dials drive the injected services when pressed', () => {
  const services = testServices()
  const layout = createLayout(services)
  const main = layout.pages[0]
  assert.ok(main, 'the layout has a first page')

  main.grid.topLeft?.press(CONTEXT)
  main.grid.bottomLeft?.press(CONTEXT)
  layout.dials[0]?.right?.run()
  layout.dials[2]?.press?.run()

  assert.deepEqual(services.calls, [
    'lva:start_listening',
    'source:aux:toggle',
    'volume:up',
    'source:usb:toggle',
  ])
})
