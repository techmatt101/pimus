// The read-only keys: clock, temperature, weather, and the page-navigation key.
// They share a shape — nothing they do changes the house — so they share a file
// rather than three near-identical ones.

import assert from 'node:assert/strict'
import test from 'node:test'

import { ClockTile, clockFace } from '../../../src/streamdeck/tiles/clock-tile.mjs'
import { PageTile } from '../../../src/streamdeck/tiles/page-tile.mjs'
import { TemperatureTile } from '../../../src/streamdeck/tiles/temperature-tile.mjs'
import { WeatherTile, conditionName } from '../../../src/streamdeck/tiles/weather-tile.mjs'
import { eventually, testContext, testHost, testServices } from '../../support/fixtures.mjs'

/** A local-time instant, so the clock assertions do not depend on the timezone. */
const at = (hours: number, minutes: number, seconds = 0): number =>
  new Date(2026, 6, 21, hours, minutes, seconds).getTime()

test('the clock reads local time and its face moves every second', () => {
  assert.deepEqual(clockFace(at(9, 5), true), { time: '09:05', date: 'TUE 21' })
  assert.deepEqual(clockFace(at(21, 5), true).time, '21:05')
  assert.deepEqual(clockFace(at(21, 5), false).time, '9:05')
  assert.deepEqual(clockFace(at(0, 30), false).time, '12:30', 'midnight is 12, not 0')

  const tile = new ClockTile()
  assert.notDeepEqual(
    tile.render(testContext(undefined, { now: at(9, 5, 10) })).buffer,
    tile.render(testContext(undefined, { now: at(9, 5, 40) })).buffer,
    'the seconds ring sweeps within the same minute',
  )
})

test('a mounted clock repaints itself and stops when it is hidden', async () => {
  const tile = new ClockTile()
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

  const unknown = tile.render().buffer
  services.ha.put('sensor.office_temperature', '21.4', { unit_of_measurement: '°C' })
  const warm = tile.render().buffer
  services.ha.put('sensor.office_temperature', '11.0', { unit_of_measurement: '°C' })
  const cold = tile.render().buffer

  assert.notDeepEqual(unknown, warm)
  // Different bands are drawn differently, so the colour carries the reading.
  assert.notDeepEqual(warm, cold)

  // A sensor that goes unavailable stops showing its last figure.
  services.ha.put('sensor.office_temperature', 'unavailable', {})
  assert.deepEqual(tile.render().buffer, unknown)
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

  const unknown = tile.render().buffer
  services.ha.put('weather.home', 'sunny', { temperature: 24 })
  const sunny = tile.render().buffer
  services.ha.put('weather.home', 'rainy', { temperature: 11 })
  const rainy = tile.render().buffer

  assert.notDeepEqual(sunny, rainy)
  assert.notDeepEqual(sunny, unknown)
  services.ha.put('weather.home', 'unavailable', {})
  assert.deepEqual(tile.render().buffer, unknown)
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
  const named = tile.render().buffer
  tile.unmount()
  assert.notDeepEqual(tile.render().buffer, named)

  const back = new PageTile({ delta: -1 })
  back.mount(host)
  back.press()
  assert.deepEqual(host.moves, [1, -1])
  assert.notDeepEqual(back.render().buffer, named, 'a backwards key points the other way')
})
