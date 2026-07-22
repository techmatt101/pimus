import assert from 'node:assert/strict'
import test from 'node:test'

import { DynamicDial } from '../../../src/streamdeck/dynamic-dial.mjs'
import { EntityToggleTile } from '../../../src/streamdeck/tiles/entity-toggle-tile.mjs'
import { eventually, testContext, testHost, testServices, tileFace } from '../../support/fixtures.mjs'

test('an entity toggle key calls the service for its own domain', () => {
  const services = testServices()
  const fan = new EntityToggleTile(services, { label: 'FAN', entity: 'fan.office_ceiling', icon: 'fan' })
  const blinds = new EntityToggleTile(services, { label: 'BLINDS', entity: 'cover.office_blinds', icon: 'computer' })

  assert.deepEqual(fan.action(), { type: 'ha', command: 'toggle', entity: 'fan.office_ceiling' })
  fan.press()
  blinds.press()

  // One tile class covers both because the service comes from the entity id.
  assert.deepEqual(services.ha.calls, ['fan.toggle fan.office_ceiling', 'cover.toggle cover.office_blinds'])
})

test('a key given the dial hands it the entity as it is pressed', () => {
  const services = testServices()
  const dial = new DynamicDial(services.model)
  const fan = new EntityToggleTile(services, { label: 'FAN', entity: 'fan.office_ceiling', icon: 'fan', dial })
  const pc = new EntityToggleTile(services, { label: 'PC', entity: 'switch.office_pc', icon: 'computer', dial })

  fan.press()
  assert.equal(dial.label, 'FAN')

  // A switch has nothing to turn, so pressing it flips the PC and leaves the
  // dial where it was rather than handing it a knob that does nothing.
  pc.press()
  assert.equal(dial.label, 'FAN')
  dial.right?.run()

  assert.deepEqual(services.ha.calls, [
    'fan.toggle fan.office_ceiling',
    'switch.toggle switch.office_pc',
    'fan.increase_speed fan.office_ceiling',
  ])
})

test('the key holding the dial is marked on its own face', () => {
  const services = testServices()
  const dial = new DynamicDial(services.model)
  services.ha.put('fan.office_ceiling', 'off')
  const fan = new EntityToggleTile(services, { label: 'FAN', entity: 'fan.office_ceiling', icon: 'fan', dial })

  const idle = tileFace(fan, testContext())
  fan.press()
  // Nothing about the fan changed — the fake records the call without applying
  // it — so any difference here is the key reporting that it has the dial.
  assert.notDeepEqual(tileFace(fan, testContext()), idle, 'the key shows it holds the dial')
})

test('a malformed entity id fails as the tile is built, not when it is pressed', () => {
  assert.throws(
    () => new EntityToggleTile(testServices(), { label: 'FAN', entity: 'office_ceiling', icon: 'fan' }),
    /not a Home Assistant entity id/,
  )
})

test('the face distinguishes on, off, and not knowing', () => {
  const services = testServices()
  const tile = new EntityToggleTile(services, { label: 'PC', entity: 'switch.office_pc', icon: 'computer' })

  const unknown = tileFace(tile, testContext())
  services.ha.put('switch.office_pc', 'off')
  const off = tileFace(tile, testContext())
  services.ha.put('switch.office_pc', 'on')
  const on = tileFace(tile, testContext())

  assert.notDeepEqual(on, off, 'on and off differ')
  // Unreachable Home Assistant must not draw as a switch that is simply off.
  assert.notDeepEqual(unknown, off, 'unknown is its own appearance, not "off"')
})

test('a mounted key follows its entity and animates only while it is on', async () => {
  const services = testServices()
  const tile = new EntityToggleTile(services, {
    label: 'FAN',
    entity: 'fan.office_ceiling',
    icon: 'fan',
    spin: (_entity: unknown, now: number) => (now % 1200) / 1200,
    animationMilliseconds: 5,
  })

  const host = testHost()
  tile.mount(host)
  assert.equal(host.repaints, 0, 'a stopped fan has nothing to turn')

  // Turning the fan on anywhere — the app, a voice command — reaches this key
  // through the watch and starts the blades.
  services.ha.put('fan.office_ceiling', 'on')
  await eventually(() => host.repaints >= 3)

  services.ha.put('fan.office_ceiling', 'off')
  const settled = host.repaints
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(host.repaints, settled, 'the animation stops with the fan')

  // Unmounting drops the watch, so a later change touches nothing.
  tile.unmount()
  assert.equal(services.ha.watchCount, 0)
  services.ha.put('fan.office_ceiling', 'on')
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(host.repaints, settled, 'an unmounted tile is inert')
})

test('an animated icon varies with time while a still one does not', () => {
  const services = testServices()
  const tile = new EntityToggleTile(services, {
    label: 'FAN',
    entity: 'fan.office_ceiling',
    icon: 'fan',
    spin: (_entity: unknown, now: number) => (now % 1200) / 1200,
  })
  services.ha.put('fan.office_ceiling', 'on')

  // Not a third of a cycle apart: three blades 120 degrees apart map exactly
  // onto themselves there, and the face would legitimately be identical.
  assert.notDeepEqual(
    tileFace(tile, testContext(undefined, { now: 0 })),
    tileFace(tile, testContext(undefined, { now: 200 })),
    'the blades turn',
  )

  const still = new EntityToggleTile(services, { label: 'PC', entity: 'switch.office_pc', icon: 'computer' })
  services.ha.put('switch.office_pc', 'on')
  assert.deepEqual(
    tileFace(still, testContext(undefined, { now: 0 })),
    tileFace(still, testContext(undefined, { now: 400 })),
    'a key with no phase is steady',
  )
})
