import assert from 'node:assert/strict'
import test from 'node:test'

import { DynamicDial, entityDial } from '../../src/streamdeck/dynamic-dial.mjs'
import { testContext, testServices } from '../support/fixtures.mjs'

const CONTEXT = testContext()

test('an unclaimed dial explains itself and turns nothing', () => {
  const dial = new DynamicDial(testServices().model)

  assert.equal(dial.label, 'CONTROL')
  assert.equal(dial.detail(CONTEXT), 'PICK A KEY')
  assert.equal(dial.level(CONTEXT), undefined)
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
  const lights = entityDial(services, 'LIGHTS', 'light.office')
  assert.ok(lights)

  dial.claim(lights)
  assert.equal(dial.label, 'LIGHTS')
  // Home Assistant reports brightness on 0-255; the dial reads as a percentage.
  assert.equal(dial.detail(CONTEXT), '50%')
  assert.equal(dial.level(CONTEXT), 128 / 255)

  dial.left?.run()
  dial.right?.run()
  dial.press?.run()
  assert.deepEqual(services.ha.calls, [
    'light.turn_on light.office {"brightness_step_pct":-10}',
    'light.turn_on light.office {"brightness_step_pct":10}',
    'light.toggle light.office',
  ])
})

test('each domain turns the way its own kind of thing does', () => {
  const services = testServices()
  services.ha.put('fan.office_ceiling', 'on', { percentage: 66 })
  services.ha.put('cover.office_blinds', 'open', { current_position: 40 })
  const fan = entityDial(services, 'FAN', 'fan.office_ceiling')
  const blinds = entityDial(services, 'BLINDS', 'cover.office_blinds')
  assert.ok(fan)
  assert.ok(blinds)

  assert.equal(fan.detail?.(CONTEXT), '66%')
  assert.equal(blinds.detail?.(CONTEXT), '40%')

  fan.right?.run()
  blinds.right?.run()
  blinds.left?.run()
  // A fan steps by its own speeds; a cover has no relative service, so the step
  // is applied to the position it last reported.
  assert.deepEqual(services.ha.calls, [
    'fan.increase_speed fan.office_ceiling',
    'cover.set_cover_position cover.office_blinds {"position":50}',
    'cover.set_cover_position cover.office_blinds {"position":30}',
  ])
})

test('a cover that reports no position is opened and closed outright', () => {
  const services = testServices()
  services.ha.put('cover.office_blinds', 'closed')
  const blinds = entityDial(services, 'BLINDS', 'cover.office_blinds')
  assert.ok(blinds)

  blinds.right?.run()
  blinds.left?.run()
  assert.deepEqual(services.ha.calls, [
    'cover.open_cover cover.office_blinds',
    'cover.close_cover cover.office_blinds',
  ])
  // Nothing to draw a bar from, but the state is still worth reading.
  assert.equal(blinds.level?.(CONTEXT), undefined)
  assert.equal(blinds.detail?.(CONTEXT), 'CLOSED')
})

test('the readout tells being off apart from not knowing', () => {
  const services = testServices()
  const lights = entityDial(services, 'LIGHTS', 'light.office')
  assert.ok(lights)

  // An unreachable Home Assistant must not read as a light turned all the way
  // down, exactly as it must not draw as a key that is simply switched off.
  assert.equal(lights.detail?.(CONTEXT), '--')
  services.ha.put('light.office', 'off')
  assert.equal(lights.detail?.(CONTEXT), 'OFF')
})

test('a domain with nothing to turn claims no dial', () => {
  assert.equal(entityDial(testServices(), 'PC', 'switch.office_pc'), undefined)
})

test('changing hands shows the dial and repaints the keys', () => {
  const services = testServices()
  let repaints = 0
  let reveals = 0
  services.model.subscribe(() => { repaints += 1 })
  const dial = new DynamicDial(services.model)
  dial.revealOn(() => { reveals += 1 })
  const lights = entityDial(services, 'LIGHTS', 'light.office')
  const fan = entityDial(services, 'FAN', 'fan.office_ceiling')
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
