import assert from 'node:assert/strict'
import test from 'node:test'

import { EntityDial } from '../../../src/streamdeck/dials/entity-dial.mjs'
import { testServices } from '../../support/fixtures.mjs'

test('each domain turns the way its own kind of thing does', () => {
  const services = testServices()
  services.ha.put('fan.office_ceiling', 'on', { percentage: 66 })
  services.ha.put('cover.office_blinds', 'open', { current_position: 40 })
  const fan = EntityDial.for(services, 'FAN', 'fan.office_ceiling')
  const blinds = EntityDial.for(services, 'BLINDS', 'cover.office_blinds')
  assert.ok(fan)
  assert.ok(blinds)

  assert.equal(fan.detail(), '66%')
  assert.equal(blinds.detail(), '40%')

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
  const blinds = EntityDial.for(services, 'BLINDS', 'cover.office_blinds')
  assert.ok(blinds)

  blinds.right?.run()
  blinds.left?.run()
  assert.deepEqual(services.ha.calls, [
    'cover.open_cover cover.office_blinds',
    'cover.close_cover cover.office_blinds',
  ])
  // Nothing to draw a bar from, but the state is still worth reading.
  assert.equal(blinds.level(), undefined)
  assert.equal(blinds.detail(), 'CLOSED')
})

test('the readout tells being off apart from not knowing', () => {
  const services = testServices()
  const lights = EntityDial.for(services, 'LIGHTS', 'light.office')
  assert.ok(lights)

  // An unreachable Home Assistant must not read as a light turned all the way
  // down, exactly as it must not draw as a key that is simply switched off.
  assert.equal(lights.detail(), '--')
  services.ha.put('light.office', 'off')
  assert.equal(lights.detail(), 'OFF')
})

test('a domain with nothing to turn claims no dial', () => {
  assert.equal(EntityDial.for(testServices(), 'PC', 'switch.office_pc'), undefined)
})
