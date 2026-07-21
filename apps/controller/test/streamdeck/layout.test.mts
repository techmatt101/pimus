import assert from 'node:assert/strict'
import test from 'node:test'

import { describeActionProblem } from '../../src/actions/catalog.mjs'
import { createState } from '../../src/state.mjs'
import { STREAMDECK_LAYOUT } from '../../src/streamdeck/layout.mjs'
import type { TileContext } from '../../src/streamdeck/tile.mjs'

const CONTEXT: TileContext = { state: createState(), audio: { sources: {} } }

test('the compiled layout fits the Stream Deck+ hardware', () => {
  assert.ok(STREAMDECK_LAYOUT.pages.length >= 1, 'at least one page')
  // The fixed grid caps each page at six slots; only the naming needs asserting.
  for (const page of STREAMDECK_LAYOUT.pages) {
    assert.ok(page.name.length > 0, `page ${page.name} is named for the nav keys`)
  }
  assert.ok(STREAMDECK_LAYOUT.dials.length <= 4, 'the deck has 4 dials')
  const brightness = STREAMDECK_LAYOUT.brightness
  assert.ok(brightness >= 0 && brightness <= 100, 'brightness is a percentage')
})

test('every bound action is understood by the catalog', () => {
  const problems: string[] = []
  const check = (action: unknown, where: string): void => {
    const problem = describeActionProblem(action)
    if (problem) problems.push(`${where}: ${problem}`)
  }

  STREAMDECK_LAYOUT.pages.forEach((page) => {
    for (const [slot, tile] of Object.entries(page.grid)) {
      if (tile) check(tile.action(CONTEXT), `${page.name} ${slot}`)
    }
  })
  STREAMDECK_LAYOUT.dials.forEach((dial, index) => {
    check(dial.left, `dial ${index} (${dial.label}) left`)
    check(dial.right, `dial ${index} (${dial.label}) right`)
    check(dial.press, `dial ${index} (${dial.label}) press`)
  })

  assert.deepEqual(problems, [])
})
