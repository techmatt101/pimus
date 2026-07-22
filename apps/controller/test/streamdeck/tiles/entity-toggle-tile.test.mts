import assert from 'node:assert/strict'
import test from 'node:test'

import { DynamicDial } from '../../../src/streamdeck/dynamic-dial.mjs'
import { EntityToggleTile } from '../../../src/streamdeck/tiles/entity-toggle-tile.mjs'
import { fanIcon, monitorIcon } from '../../../src/streamdeck/icons.mjs'
import { eventually, testContext, testHost, testServices } from '../../support/fixtures.mjs'

test('an entity toggle key calls the service for its own domain', () => {
  const services = testServices()
  const fan = new EntityToggleTile(services, { label: 'FAN', entity: 'fan.office_ceiling', icon: fanIcon })
  const blinds = new EntityToggleTile(services, { label: 'BLINDS', entity: 'cover.office_blinds', icon: monitorIcon })

  assert.deepEqual(fan.action(), { type: 'ha', command: 'toggle', entity: 'fan.office_ceiling' })
  fan.press()
  blinds.press()

  // One tile class covers both because the service comes from the entity id.
  assert.deepEqual(services.ha.calls, ['fan.toggle fan.office_ceiling', 'cover.toggle cover.office_blinds'])
})

test('a key given the dial hands it the entity as it is pressed', () => {
  const services = testServices()
  const dial = new DynamicDial(services.model)
  const fan = new EntityToggleTile(services, { label: 'FAN', entity: 'fan.office_ceiling', icon: fanIcon, dial })
  const pc = new EntityToggleTile(services, { label: 'PC', entity: 'switch.office_pc', icon: monitorIcon, dial })

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
  const fan = new EntityToggleTile(services, { label: 'FAN', entity: 'fan.office_ceiling', icon: fanIcon, dial })

  const idle = fan.render(testContext()).buffer
  fan.press()
  // Nothing about the fan changed — the fake records the call without applying
  // it — so any difference here is the key reporting that it has the dial.
  assert.notDeepEqual(fan.render(testContext()).buffer, idle, 'the key shows it holds the dial')
})

test('a malformed entity id fails as the tile is built, not when it is pressed', () => {
  assert.throws(
    () => new EntityToggleTile(testServices(), { label: 'FAN', entity: 'office_ceiling', icon: fanIcon }),
    /not a Home Assistant entity id/,
  )
})

test('the face distinguishes on, off, and not knowing', () => {
  const services = testServices()
  const tile = new EntityToggleTile(services, { label: 'PC', entity: 'switch.office_pc', icon: monitorIcon })

  const unknown = tile.render(testContext()).buffer
  services.ha.put('switch.office_pc', 'off')
  const off = tile.render(testContext()).buffer
  services.ha.put('switch.office_pc', 'on')
  const on = tile.render(testContext()).buffer

  assert.notDeepEqual(on, off, 'on and off differ')
  // Unreachable Home Assistant must not draw as a switch that is simply off.
  assert.notDeepEqual(unknown, off, 'unknown is its own appearance, not "off"')
})

test('a mounted key follows its entity and animates only while it is on', async () => {
  const services = testServices()
  const tile = new EntityToggleTile(services, {
    label: 'FAN',
    entity: 'fan.office_ceiling',
    icon: fanIcon,
    phase: (_entity, now) => (now % 1200) / 1200,
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
    icon: fanIcon,
    phase: (_entity, now) => (now % 1200) / 1200,
  })
  services.ha.put('fan.office_ceiling', 'on')

  // Not a third of a cycle apart: three blades 120 degrees apart map exactly
  // onto themselves there, and the face would legitimately be identical.
  assert.notDeepEqual(
    tile.render(testContext(undefined, { now: 0 })).buffer,
    tile.render(testContext(undefined, { now: 200 })).buffer,
    'the blades turn',
  )

  const still = new EntityToggleTile(services, { label: 'PC', entity: 'switch.office_pc', icon: monitorIcon })
  services.ha.put('switch.office_pc', 'on')
  assert.deepEqual(
    still.render(testContext(undefined, { now: 0 })).buffer,
    still.render(testContext(undefined, { now: 400 })).buffer,
    'a key with no phase is steady',
  )
})
