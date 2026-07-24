import assert from 'node:assert/strict'
import test from 'node:test'

import { PageDial, type PageNavigator } from '../../../src/streamdeck/dials/page-dial.mjs'

test('the page dial pages the grid and reads out where it landed', () => {
  const moves: number[] = []
  let page = 'MAIN'
  const dial = new PageDial()

  // Until a renderer is connected the dial names itself and its turns do
  // nothing, so a test that builds the layout alone never has to wire one up.
  assert.equal(dial.label, 'PAGE')
  assert.equal(dial.detail(), 'PAGE')
  dial.right.run()
  assert.equal(moves.length, 0)

  const nav: PageNavigator = {
    changePage: (delta) => { moves.push(delta); page = delta > 0 ? 'ROOM' : 'INFO' },
    currentName: () => page,
  }
  dial.connect(nav)

  // A turn moves by a whole page each way, and the readout follows the page.
  dial.right.run()
  assert.equal(dial.detail(), 'ROOM')
  dial.left.run()
  assert.equal(dial.detail(), 'INFO')
  assert.deepEqual(moves, [1, -1])

  // There is no press binding: pressing the dial or its strip zone does nothing.
  assert.equal('press' in dial, false)
})
