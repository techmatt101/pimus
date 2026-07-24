import assert from 'node:assert/strict'
import test from 'node:test'

import { DynamicDial } from '../../../src/streamdeck/dials/dynamic-dial.mjs'
import { EntityDial } from '../../../src/streamdeck/dials/entity-dial.mjs'
import { testServices } from '../../support/fixtures.mjs'

test('an unclaimed dial explains itself and turns nothing', () => {
  const dial = new DynamicDial(testServices().model)

  assert.equal(dial.label, 'CONTROL')
  assert.equal(dial.detail(), 'PICK A KEY')
  assert.equal(dial.level(), undefined)
  // Not bound rather than bound to nothing, so a turn before the first press
  // reaches Home Assistant with no entity in mind.
  assert.equal(dial.left, undefined)
  assert.equal(dial.right, undefined)
  assert.equal(dial.press, undefined)
})

test('a claimed dial turns the entity it was handed', () => {
  const services = testServices()
  services.ha.put('light.office', 'on', { brightness: 128 })
  const dial = new DynamicDial(services.model)
  const lights = EntityDial.for(services, 'LIGHTS', 'light.office')
  assert.ok(lights)

  dial.claim(lights)
  assert.equal(dial.label, 'LIGHTS')
  // Home Assistant reports brightness on 0-255; the dial reads as a percentage.
  assert.equal(dial.detail(), '50%')
  assert.equal(dial.level(), 128 / 255)

  dial.left?.run()
  dial.right?.run()
  dial.press?.run()
  assert.deepEqual(services.ha.calls, [
    'light.turn_on light.office {"brightness_step_pct":-10}',
    'light.turn_on light.office {"brightness_step_pct":10}',
    'light.toggle light.office',
  ])
})

test('changing hands shows the dial and repaints the keys', () => {
  const services = testServices()
  let repaints = 0
  let reveals = 0
  services.model.subscribe(() => { repaints += 1 })
  const dial = new DynamicDial(services.model)
  dial.revealOn(() => { reveals += 1 })
  const lights = EntityDial.for(services, 'LIGHTS', 'light.office')
  const fan = EntityDial.for(services, 'FAN', 'fan.office_ceiling')
  assert.ok(lights)
  assert.ok(fan)

  dial.claim(lights)
  assert.equal(dial.holds(lights), true)

  // Pressing the same key again still puts the readout on the strip — that is
  // usually why you pressed it — but nothing moved, so no key needs redrawing.
  dial.claim(lights)
  assert.equal(reveals, 2)
  assert.equal(repaints, 1)

  dial.claim(fan)
  assert.equal(dial.holds(fan), true)
  assert.equal(dial.holds(lights), false, 'only one key holds the dial')
  assert.equal(repaints, 2)
})
