import assert from 'node:assert/strict'
import test from 'node:test'

import { describeActionProblem } from '../../src/actions/catalog.mjs'
import { STREAMDECK_LAYOUT } from '../../src/streamdeck/layout.mjs'

test('the compiled layout fits the Stream Deck+ hardware', () => {
  assert.ok(STREAMDECK_LAYOUT.keys.length <= 8, 'the deck has 8 keys')
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

  STREAMDECK_LAYOUT.keys.forEach((key, index) => check(key.action, `key ${index} (${key.label})`))
  STREAMDECK_LAYOUT.dials.forEach((dial, index) => {
    check(dial.left, `dial ${index} (${dial.label}) left`)
    check(dial.right, `dial ${index} (${dial.label}) right`)
    check(dial.press, `dial ${index} (${dial.label}) press`)
  })

  assert.deepEqual(problems, [])
})
