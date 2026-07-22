import assert from 'node:assert/strict'
import test from 'node:test'

import { createCanvas, loadImage } from '@napi-rs/canvas'

import { RemoteTile } from '../../../src/streamdeck/tiles/remote-tile.mjs'
import type { RemoteTileFace, RemoteTileFeed } from '../../../src/types.mjs'
import { testServices, tileFace } from '../../support/fixtures.mjs'

/** A feed the test writes directly, standing in for the remote-tile server. */
class FakeFeed implements RemoteTileFeed {
  readonly faces = new Map<number, RemoteTileFace>()
  readonly presses: number[] = []
  tile(slot: number): RemoteTileFace | undefined {
    return this.faces.get(slot)
  }
  press(slot: number): void {
    this.presses.push(slot)
  }
}

function remoteTile(slot: number): { tile: RemoteTile; feed: FakeFeed } {
  const feed = new FakeFeed()
  const tile = new RemoteTile({ ...testServices(), remote: feed }, { slot })
  return { tile, feed }
}

test('a press reports its slot to the feed, and is harmless without one', () => {
  const { tile, feed } = remoteTile(3)
  tile.press()
  assert.deepEqual(feed.presses, [3])

  // A layout only builds RemoteTiles when the feed exists, but the tile must
  // still not depend on that for its own safety.
  new RemoteTile(testServices(), { slot: 3 }).press()
})

test('an empty slot, a labelled face, and a pushed image all look different', async () => {
  const { tile, feed } = remoteTile(0)
  const empty = tileFace(tile)

  feed.faces.set(0, { label: 'SLACK', color: '#4a154b' })
  const labelled = tileFace(tile)
  assert.notDeepEqual(labelled.buffer, empty.buffer, 'a pushed face changes the key')

  const canvas = createCanvas(120, 120)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ff8800'
  ctx.fillRect(0, 0, 120, 120)
  feed.faces.set(0, { label: 'SLACK', color: '#4a154b', image: await loadImage(canvas.toBuffer('image/png')) })
  const imaged = tileFace(tile)
  assert.notDeepEqual(imaged.buffer, labelled.buffer, 'the image fills the face')

  feed.faces.delete(0)
  assert.deepEqual(tileFace(tile).buffer, empty.buffer, 'a cleared slot returns to empty')
})
