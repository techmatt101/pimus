import assert from 'node:assert/strict'
import test from 'node:test'

import { EntityStore } from '../../src/home-assistant/store.mjs'
import type { HomeAssistantEntity } from '../../src/types.mjs'

const entity = (
  entityId: string,
  state: string,
  attributes: Record<string, unknown> = {},
): HomeAssistantEntity => ({ entity_id: entityId, state, attributes })

test('watchers hear only about the entities they asked for', () => {
  const store = new EntityStore()
  const heard: string[] = []
  store.watch(['fan.office'], () => heard.push('fan'))
  store.watch(['light.office', 'fan.office'], () => heard.push('both'))

  store.set(entity('fan.office', 'on'))
  store.set(entity('light.office', 'on'))
  // Nothing is watching the blinds, so a change to them wakes no tile.
  store.set(entity('cover.blinds', 'open'))

  assert.deepEqual(heard, ['fan', 'both', 'both'])
  assert.equal(store.get('fan.office')?.state, 'on')
})

test('an unchanged report does not repaint the deck', () => {
  const store = new EntityStore()
  let changes = 0
  store.watch(['sensor.office'], () => { changes += 1 })

  store.set(entity('sensor.office', '21.4', { unit_of_measurement: '°C' }))
  store.set(entity('sensor.office', '21.4', { unit_of_measurement: '°C' }))
  assert.equal(changes, 1, 'the same reading again is not a change')

  store.set(entity('sensor.office', '21.5', { unit_of_measurement: '°C' }))
  assert.equal(changes, 2)

  // An attribute change alone still matters: shuffle and brightness live there.
  store.set(entity('sensor.office', '21.5', { unit_of_measurement: 'K' }))
  assert.equal(changes, 3)
})

test('a snapshot keeps only watched entities and reports the replacement', () => {
  const store = new EntityStore()
  let changes = 0
  store.watch(['fan.office'], () => { changes += 1 })

  store.replace([entity('fan.office', 'on'), entity('light.hall', 'on')])
  assert.equal(store.get('fan.office')?.state, 'on')
  // A house has hundreds of entities and this daemon draws eight keys.
  assert.equal(store.get('light.hall'), undefined, 'unwatched entities are not cached')
  assert.equal(changes, 1)
})

test('losing the connection clears the cache so nothing stale looks live', () => {
  const store = new EntityStore()
  let changes = 0
  store.watch(['fan.office'], () => { changes += 1 })
  store.set(entity('fan.office', 'on'))

  store.clear()
  assert.equal(store.get('fan.office'), undefined)
  assert.equal(changes, 2)

  // Clearing an empty cache is not a change, so a reconnect loop cannot spin
  // the renderer.
  store.clear()
  assert.equal(changes, 2)
})

test('unwatching stops delivery and shrinks the watched set', () => {
  const store = new EntityStore()
  let changes = 0
  const unwatch = store.watch(['fan.office'], () => { changes += 1 })
  assert.deepEqual([...store.watched()], ['fan.office'])

  unwatch()
  assert.deepEqual([...store.watched()], [], 'an unmounted tile watches nothing')
  store.set(entity('fan.office', 'off'))
  assert.equal(changes, 0)
})
