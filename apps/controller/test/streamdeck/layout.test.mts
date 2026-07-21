import assert from 'node:assert/strict'
import test from 'node:test'

import { describeActionProblem } from '../../src/actions/catalog.mjs'
import { createLayout } from '../../src/streamdeck/layout.mjs'
import { dialDetail } from '../../src/streamdeck/renderer.mjs'
import { SceneTile } from '../../src/streamdeck/tiles/scene-tile.mjs'
import { testContext, testServices } from '../support/fixtures.mjs'

const CONTEXT = testContext()

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
  // The audio mode key reconciles every route it owns, not just the one it is
  // moving to, so no press can leave two inputs enabled at once.
  main.grid.bottomLeft?.press(CONTEXT)
  layout.dials[0]?.right?.run()

  assert.deepEqual(services.calls, [
    'lva:start_listening',
    'source:aux:on',
    'source:usb:off',
    'volume:up',
  ])
})

test('every dial readout is a short string, whatever the deck knows', () => {
  const services = testServices()
  const layout = createLayout(services)
  // Nothing is connected in this fixture, which is the worst case for a
  // readout: it must still render rather than throw or print "undefined".
  for (const dial of layout.dials) {
    const detail = dialDetail(CONTEXT, dial)
    assert.equal(typeof detail, 'string')
    assert.ok(detail.length > 0 && detail.length <= 12, `${dial.label} readout "${detail}" fits the strip`)
  }
})

test('a mistyped Home Assistant entity id fails while the layout is built', () => {
  // The tiles that hold several entities cannot expose them all as one
  // action(), so they check the ids themselves as they are constructed.
  assert.throws(
    () => new SceneTile(testServices(), { scenes: [{ label: 'X', entity: 'scene office' }] }),
    /not a Home Assistant entity id/,
  )
})
