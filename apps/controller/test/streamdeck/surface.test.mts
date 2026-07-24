import assert from 'node:assert/strict'
import test from 'node:test'

import { ICON_MARKUP } from '../../src/streamdeck/icon-set.mjs'
import { conditionIcon } from '../../src/streamdeck/icons.mjs'
import { fittingSize, icon, lighten, measureText, Surface, text, withAlpha } from '../../src/streamdeck/surface.mjs'

/** The four channels of one pixel of a face. */
const pixelAt = (surface: Surface, x: number, y: number): number[] => {
  const buffer = surface.snapshot()
  const offset = (y * surface.width + x) * 4
  return [...buffer.subarray(offset, offset + 4)]
}

test('a surface paints an RGBA face the deck can be given directly', () => {
  const surface = new Surface(120, 120)
  surface.reset('#102030')

  assert.equal(surface.snapshot().length, 120 * 120 * 4)
  assert.deepEqual(pixelAt(surface, 60, 60), [16, 32, 48, 255])

  // reset() clears whatever the last face left behind, so a tile that leaves a
  // transform or an alpha set cannot corrupt the key drawn after it.
  surface.ctx.globalAlpha = 0.1
  surface.ctx.translate(40, 40)
  surface.reset('#102030')
  assert.deepEqual(pixelAt(surface, 60, 60), [16, 32, 48, 255])
})

test('colours are lightened for the key wash and faded for glows', () => {
  assert.equal(lighten('#000000', 0.5), '#808080')
  assert.equal(lighten('#102030', 0), '#102030')
  assert.equal(lighten('#ffffff', 1), '#ffffff')
  assert.equal(withAlpha('#102030', 0.5), 'rgba(16,32,48,0.5)')
})

test('the bundled font is registered, so text actually draws', () => {
  // The Pi ships almost no system fonts: were the bundled face not found, every
  // label would silently draw as nothing while the layout still looked right.
  const surface = new Surface(120, 120)
  surface.reset('#000000')
  text(surface, 'WW', { x: 60, y: 60, size: 40 })

  const lit = surface.snapshot().filter((channel, index) => index % 4 !== 3 && channel > 0)
  assert.ok(lit.length > 0, 'the glyphs put ink on the face')
  assert.ok(measureText('WWWW', 40) > measureText('II', 40), 'measurement follows the glyphs')
})

test('a value is drawn at the largest size that fits the space it has', () => {
  const sizes = [46, 38, 30, 24]
  assert.equal(fittingSize('7', sizes, 108), 46)
  assert.equal(fittingSize('DISCONNECTED', sizes, 108), 24, 'an overlong value falls back to the smallest')
  assert.ok(fittingSize('88:88', sizes, 108) <= 46)
})

test('icons rasterize at the size and tint they are asked for', () => {
  const surface = new Surface(120, 120)
  surface.reset('#000000')
  icon(surface, 'mic', { x: 60, y: 60, size: 60, color: '#ff0000' })
  const red = surface.snapshot()

  surface.reset('#000000')
  icon(surface, 'mic', { x: 60, y: 60, size: 60, color: '#00ff00' })
  assert.notDeepEqual(surface.snapshot(), red, 'the tint reaches the artwork')

  surface.reset('#000000')
  icon(surface, 'mic', { x: 60, y: 60, size: 30, color: '#ff0000' })
  assert.notDeepEqual(surface.snapshot(), red, 'the icon is drawn at the size asked for')

  // Rotation is what turns the fan blades, so it has to change the face.
  surface.reset('#000000')
  icon(surface, 'fan', { x: 60, y: 60, size: 60, color: '#ffffff' })
  const upright = surface.snapshot()
  surface.reset('#000000')
  icon(surface, 'fan', { x: 60, y: 60, size: 60, color: '#ffffff', rotate: 0.2 })
  assert.notDeepEqual(surface.snapshot(), upright)
})

test('every weather condition maps to an icon that exists', () => {
  const conditions = [
    'clear-night', 'cloudy', 'exceptional', 'fog', 'hail', 'lightning', 'lightning-rainy',
    'partlycloudy', 'pouring', 'rainy', 'snowy', 'snowy-rainy', 'sunny', 'windy', 'windy-variant',
    // Anything Home Assistant adds later must still name a real icon.
    'meteor-shower',
  ]
  for (const condition of conditions) {
    const { icon, color } = conditionIcon(condition)
    assert.ok(icon in ICON_MARKUP, `${condition} -> ${icon}`)
    assert.match(color, /^#[0-9a-f]{6}$/)
  }
})
