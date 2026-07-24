import assert from 'node:assert/strict'
import test from 'node:test'

import { describeActionProblem } from '../../src/actions/catalog.mjs'
import { createState } from '../../src/state.mjs'
import { createLayout } from '../../src/streamdeck/layout.mjs'
import { SceneTile } from '../../src/streamdeck/tiles/scene-tile.mjs'
import { testServices } from '../support/fixtures.mjs'

test('the compiled layout fits the Stream Deck+ hardware', () => {
  const layout = createLayout(testServices())
  assert.ok(layout.pages.length >= 1, 'at least one page')
  // The fixed grid caps each page at eight slots; only the naming needs asserting.
  for (const page of layout.pages) {
    assert.ok(page.name.length > 0, `page ${page.name} is named for the nav keys`)
  }
  assert.ok(layout.dials.length <= 4, 'the deck has 4 dials')
  // Brightness is runtime state now, not a layout field; it starts a percentage.
  const brightness = createState().brightness
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

test('the REMOTE page exists exactly when the remote-tile feed does', () => {
  // Without the feature nothing could ever fill the slots, so the page—unlike
  // the Home Assistant keys, which show unknown state instead—is not built.
  const without = createLayout(testServices())
  assert.ok(!without.pages.some((page) => page.name === 'REMOTE'))

  const layout = createLayout({ ...testServices(), remote: { tile: () => undefined, press: () => {} } })
  const page = layout.pages.find((candidate) => candidate.name === 'REMOTE')
  assert.ok(page, 'a configured feed adds the page')
  assert.equal(Object.values(page.grid).filter(Boolean).length, 6, 'every slot is a socket')
})

test('layout tiles and dials drive the injected services when pressed', () => {
  const services = testServices()
  const layout = createLayout(services)
  const main = layout.pages[0]
  assert.ok(main, 'the layout has a first page')

  main.grid.topLeft?.press()
  // Each audio route has its own key now, toggling just that route on or off.
  main.grid.bottomMidLeft?.press()
  main.grid.bottomMidRight?.press()
  layout.dials[0]?.right?.run()

  assert.deepEqual(services.calls, [
    'lva:start_listening',
    'source:aux:toggle',
    'source:usb:toggle',
    'volume:up',
  ])
})

test('the dynamic dial follows the last room key pressed', () => {
  const services = testServices()
  services.ha.put('light.office', 'on', { brightness: 128 })
  const layout = createLayout(services)
  const room = layout.pages[1]
  const dial = layout.dials[3]
  assert.ok(room, 'the layout has a ROOM page')
  assert.ok(dial, 'the layout has a fourth dial')

  // Before anything is pressed the dial says what it is for rather than
  // pretending to control something.
  assert.equal(dial.detail(), 'PICK A KEY')

  room.grid.bottomMidRight?.press()
  assert.equal(dial.label, 'LIGHTS')
  assert.equal(dial.detail(), '50%')
  dial.right?.run()

  room.grid.topMidLeft?.press()
  assert.equal(dial.label, 'FAN')
  dial.right?.run()

  assert.deepEqual(services.ha.calls, [
    'light.toggle light.office',
    'light.turn_on light.office {"brightness_step_pct":10}',
    'fan.toggle fan.office_ceiling',
    'fan.increase_speed fan.office_ceiling',
  ])
})

test('every dial readout is a short string, whatever the deck knows', () => {
  const services = testServices()
  const layout = createLayout(services)
  // Nothing is connected in this fixture, which is the worst case for a
  // readout: it must still render rather than throw or print "undefined".
  for (const dial of layout.dials) {
    const detail = dial.detail()
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
