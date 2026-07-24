import assert from 'node:assert/strict'
import test from 'node:test'

import { TimerTile } from '../../../src/streamdeck/tiles/timer-tile.mjs'
import { eventually, testHost, testServices, tileFace } from '../../support/fixtures.mjs'

const NOW = Date.parse('2026-07-21T10:00:00Z')
const RUNNING = {
  state: 'active',
  attributes: { duration: '0:05:00', remaining: '0:05:00', finishes_at: '2026-07-21T10:04:00+00:00' },
}

test('one key starts an idle timer and cancels the running one', () => {
  const services = testServices()
  const tile = new TimerTile(services, { entity: 'timer.office', duration: '00:05:00' })
  assert.deepEqual(tile.action(), {
    type: 'ha',
    command: 'timer_toggle',
    entity: 'timer.office',
    data: { duration: '00:05:00' },
  })

  services.ha.put('timer.office', 'idle', { duration: '0:05:00' })
  tile.press()
  services.ha.put('timer.office', RUNNING.state, RUNNING.attributes)
  // A second press must not restart the timer it is showing.
  tile.press()

  assert.deepEqual(services.ha.calls, [
    'timer.start timer.office {"duration":"00:05:00"}',
    'timer.cancel timer.office',
  ])
})

test('the countdown is derived from the finish time, not from Home Assistant ticking', () => {
  const services = testServices()
  const tile = new TimerTile(services, { entity: 'timer.office' })
  services.ha.put('timer.office', RUNNING.state, RUNNING.attributes)

  // Home Assistant reports a running timer once and then says nothing, so the
  // face has to change with the clock alone.
  services.setNow(NOW)
  const start = tileFace(tile)
  services.setNow(NOW + 60_000)
  const later = tileFace(tile)
  assert.notDeepEqual(start, later, 'the countdown moves between reports')

  // A paused timer holds its reading instead of counting down to zero.
  services.ha.put('timer.office', 'paused', { duration: '0:05:00', remaining: '0:03:20' })
  services.setNow(NOW)
  const paused = tileFace(tile)
  services.setNow(NOW + 60_000)
  assert.deepEqual(paused, tileFace(tile))
})

test('an unknown timer draws its own face rather than a zeroed countdown', () => {
  const services = testServices()
  const tile = new TimerTile(services, { entity: 'timer.office' })

  services.setNow(NOW)
  const unknown = tileFace(tile)
  services.ha.put('timer.office', 'idle', { duration: '0:05:00' })
  const idle = tileFace(tile)
  assert.notDeepEqual(unknown, idle)
})

test('a mounted timer ticks only while it is running and drops its watch on unmount', async () => {
  const services = testServices()
  const tile = new TimerTile(services, { entity: 'timer.office' })
  const host = testHost()

  services.ha.put('timer.office', 'idle', { duration: '0:05:00' })
  tile.mount(host)
  const idle = host.repaints
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(host.repaints, idle, 'an idle timer needs no repaints')

  services.ha.put('timer.office', RUNNING.state, RUNNING.attributes)
  await eventually(() => host.repaints > idle + 1)

  tile.unmount()
  assert.equal(services.ha.watchCount, 0)
  const settled = host.repaints
  await new Promise((resolve) => setTimeout(resolve, 600))
  assert.equal(host.repaints, settled, 'an unmounted countdown stops ticking')
})
