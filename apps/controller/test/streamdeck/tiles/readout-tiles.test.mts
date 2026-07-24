// The read-only keys: clock, temperature, weather, and the page-navigation key.
// They share a shape — nothing they do changes the house — so they share a file
// rather than three near-identical ones.

import assert from 'node:assert/strict'
import test from 'node:test'

import { ClockTile, clockFace } from '../../../src/streamdeck/tiles/clock-tile.mjs'
import { PageTile } from '../../../src/streamdeck/tiles/page-tile.mjs'
import { TemperatureTile } from '../../../src/streamdeck/tiles/temperature-tile.mjs'
import { WeatherTile, conditionName } from '../../../src/streamdeck/tiles/weather-tile.mjs'
import { eventually, testHost, testServices, tileFace } from '../../support/fixtures.mjs'

/** A local-time instant, so the clock assertions do not depend on the timezone. */
const at = (hours: number, minutes: number, seconds = 0): number =>
  new Date(2026, 6, 21, hours, minutes, seconds).getTime()

test('the clock reads local time and its face moves every second', () => {
  assert.deepEqual(clockFace(at(9, 5), true), { time: '09:05', date: 'TUE 21' })
  assert.deepEqual(clockFace(at(21, 5), true).time, '21:05')
  assert.deepEqual(clockFace(at(21, 5), false).time, '9:05')
  assert.deepEqual(clockFace(at(0, 30), false).time, '12:30', 'midnight is 12, not 0')

  const services = testServices()
  const tile = new ClockTile(services)
  services.setNow(at(9, 5, 10))
  const early = tileFace(tile)
  services.setNow(at(9, 5, 40))
  assert.notDeepEqual(early, tileFace(tile), 'the seconds ring sweeps within the same minute')
})

test('a mounted clock repaints itself and stops when it is hidden', async () => {
  const services = testServices()
  // Just before a second boundary, so the tile's next-second tick fires soon.
  services.setNow(999)
  const tile = new ClockTile(services)
  const host = testHost()
  tile.mount(host)
  await eventually(() => host.repaints >= 1)

  tile.unmount()
  const settled = host.repaints
  await new Promise((resolve) => setTimeout(resolve, 1200))
  assert.equal(host.repaints, settled, 'a hidden clock stops its timer')
})

test('a temperature key shows the reading, and says so when there is none', () => {
  const services = testServices()
  const tile = new TemperatureTile(services, { label: 'OFFICE', entity: 'sensor.office_temperature' })

  const unknown = tileFace(tile)
  services.ha.put('sensor.office_temperature', '21.4', { unit_of_measurement: '°C' })
  const warm = tileFace(tile)
  services.ha.put('sensor.office_temperature', '11.0', { unit_of_measurement: '°C' })
  const cold = tileFace(tile)

  assert.notDeepEqual(unknown, warm)
  // Different bands are drawn differently, so the colour carries the reading.
  assert.notDeepEqual(warm, cold)

  // A sensor that goes unavailable stops showing its last figure.
  services.ha.put('sensor.office_temperature', 'unavailable', {})
  assert.deepEqual(tileFace(tile), unknown)
})

test('reading keys watch their entity only while mounted and never act', () => {
  const services = testServices()
  const temperature = new TemperatureTile(services, { label: 'OFFICE', entity: 'sensor.office_temperature' })
  const weather = new WeatherTile(services, { entity: 'weather.home' })
  const host = testHost()

  temperature.mount(host)
  weather.mount(host)
  assert.equal(services.ha.watchCount, 2)

  // Pressing a readout key must not call a service by accident.
  temperature.press()
  weather.press()
  assert.deepEqual(services.ha.calls, [])

  temperature.unmount()
  weather.unmount()
  assert.equal(services.ha.watchCount, 0)
})

test('weather conditions get short names, including ones not in the table', () => {
  assert.equal(conditionName('partlycloudy'), 'PART SUN')
  assert.equal(conditionName('lightning-rainy'), 'STORM')
  // An upstream addition still labels the key rather than blanking it.
  assert.equal(conditionName('sandstorm-variant'), 'SANDSTORM VARIANT')
})

test('the weather key draws the condition and falls back when it is unknown', () => {
  const services = testServices()
  const tile = new WeatherTile(services, { entity: 'weather.home' })

  const unknown = tileFace(tile)
  services.ha.put('weather.home', 'sunny', { temperature: 24 })
  const sunny = tileFace(tile)
  services.ha.put('weather.home', 'rainy', { temperature: 11 })
  const rainy = tileFace(tile)

  assert.notDeepEqual(sunny, rainy)
  assert.notDeepEqual(sunny, unknown)
  services.ha.put('weather.home', 'unavailable', {})
  assert.deepEqual(tileFace(tile), unknown)
})

test('a page key moves the deck through its host, and only while mounted', () => {
  const tile = new PageTile({ delta: 1 })
  const host = testHost()

  // Before mounting there is no page to leave, so the press does nothing.
  tile.press()
  assert.deepEqual(host.moves, [])

  tile.mount(host)
  tile.press()
  assert.deepEqual(host.moves, [1])

  // A mounted key names the page it moves to; an unmounted one cannot.
  const named = tileFace(tile)
  tile.unmount()
  assert.notDeepEqual(tileFace(tile), named)

  const back = new PageTile({ delta: -1 })
  back.mount(host)
  back.press()
  assert.deepEqual(host.moves, [1, -1])
  assert.notDeepEqual(tileFace(back), named, 'a backwards key points the other way')
})
