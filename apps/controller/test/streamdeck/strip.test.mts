import assert from 'node:assert/strict'
import test from 'node:test'

import { createState } from '../../src/state.mjs'
import type { Binding } from '../../src/streamdeck/bindings.mjs'
import { createStrip, type Screen, type ScreenContext } from '../../src/streamdeck/screens/screen.mjs'
import { TouchStrip } from '../../src/streamdeck/strip.mjs'
import { testContext, testScreenHost } from '../support/fixtures.mjs'
import type { Bitmap, Notification, NotificationFeed } from '../../src/types.mjs'

/** A resting screen that records how often it was asked to draw. */
class RestingScreen implements Screen {
  drawn = 0
  mounted = 0

  render(): Bitmap {
    this.drawn += 1
    return createStrip('#000000')
  }

  mount(): void {
    this.mounted += 1
  }

  unmount(): void {
    this.mounted -= 1
  }
}

/** A feed holding one message, so a test controls exactly when it is live. */
class TestFeed implements NotificationFeed {
  dismissed = 0

  constructor(private notification: Notification | undefined) {}

  current(now: number): Notification | undefined {
    return this.notification && now < this.notification.expiresAt ? this.notification : undefined
  }

  dismiss(): void {
    this.dismissed += 1
    this.notification = undefined
  }
}

const notification = (expiresAt = 10_000): Notification =>
  ({ title: 'FRONT DOOR', message: 'SOMEONE IS AT THE DOOR', color: '#b71c1c', shownAt: 0, expiresAt })

const pressed: string[] = []
const dial = (label: string): { label: string; press: Binding } => ({
  label,
  press: { action: { type: 'noop' }, run: () => pressed.push(label) },
})

test('the strip rests on what is playing and hands itself to the dial being turned', () => {
  const resting = new RestingScreen()
  const strip = new TouchStrip({ resting, dials: [dial('VOLUME'), dial('MEDIA')] })

  const idle = strip.render(testContext(createState(), { now: 1000 }))
  assert.deepEqual([idle.width, idle.height], [800, 100])
  assert.equal(resting.drawn, 1)

  // Turning a dial takes the strip over, and lets it go again afterwards.
  strip.showDial(0, 1000)
  const turning = strip.render(testContext(createState(), { now: 1100 }))
  assert.notDeepEqual(turning.buffer, idle.buffer)
  assert.equal(resting.drawn, 1, 'the resting screen is not drawn while a dial is showing')

  strip.render(testContext(createState(), { now: 1000 + 2500 }))
  assert.equal(resting.drawn, 2, 'the hold expires and what is playing comes back')

  // A dial index the layout does not have is ignored rather than blanking the strip.
  strip.showDial(7, 5000)
  strip.render(testContext(createState(), { now: 5000 }))
  assert.equal(resting.drawn, 3)
})

test('a notification takes the strip, but a hand on a dial takes it back', () => {
  const resting = new RestingScreen()
  const feed = new TestFeed(notification())
  const strip = new TouchStrip({ resting, dials: [dial('VOLUME')], notifications: feed })

  const banner = strip.render(testContext(createState(), { now: 0 }))
  assert.equal(resting.drawn, 0, 'the banner is over what is playing')

  // Feedback you cannot see while turning is no feedback, so the dial wins.
  strip.showDial(0, 100)
  const turning = strip.render(testContext(createState(), { now: 100 }))
  assert.notDeepEqual(turning.buffer, banner.buffer)

  // …and the notification is still there when the hand comes off.
  strip.render(testContext(createState(), { now: 3000 }))
  assert.equal(resting.drawn, 0)
  strip.render(testContext(createState(), { now: 10_000 }))
  assert.equal(resting.drawn, 1, 'an expired notification hands the strip back')
})

test('a tap acknowledges a notification, and otherwise presses the dial beneath it', () => {
  pressed.length = 0
  const feed = new TestFeed(notification())
  const dials = [dial('VOLUME'), dial('MEDIA'), dial('LIGHTS'), dial('VOICE')]
  const strip = new TouchStrip({ resting: new RestingScreen(), dials, notifications: feed })

  // While a banner is up the tap belongs to it: the dial labels are not even
  // visible to aim at.
  assert.equal(strip.pressAt(120, 0), undefined)
  assert.equal(feed.dismissed, 1)
  assert.deepEqual(pressed, [])

  // With the banner gone, each zone presses its own dial.
  strip.pressAt(120, 1)?.()
  strip.pressAt(650, 2)?.()
  assert.deepEqual(pressed, ['VOLUME', 'VOICE'])

  // An x beyond the strip still lands on a real dial rather than nothing.
  strip.pressAt(5000, 3)?.()
  assert.deepEqual(pressed, ['VOLUME', 'VOICE', 'VOICE'])
})

test('the strip mounts its screens with the deck and drops its timers with it', async () => {
  const resting = new RestingScreen()
  const strip = new TouchStrip({ resting, dials: [dial('VOLUME')] })
  const host = testScreenHost()

  strip.mount(host)
  assert.equal(resting.mounted, 1)

  // A dial hold arms one wake-up, so the readout expires without waiting for
  // something else to repaint the deck.
  strip.showDial(0)
  assert.equal(host.repaints, 1, 'touching a dial repaints at once')
  strip.render(testContext(createState(), { now: Date.now() }))
  await new Promise((resolve) => setTimeout(resolve, 60))

  strip.unmount()
  assert.equal(resting.mounted, 0)
  const settled = host.repaints
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(host.repaints, settled, 'an unmounted strip stops asking for repaints')
})

test('a scrolling screen gets frames while it is showing, and only then', async () => {
  /** A resting screen that always wants frames, standing in for a long title. */
  class ScrollingScreen implements Screen {
    render(): Bitmap {
      return createStrip('#000000')
    }

    animationMilliseconds(_context: ScreenContext): number {
      return 20
    }
  }

  const strip = new TouchStrip({ resting: new ScrollingScreen(), dials: [dial('VOLUME')] })
  const host = testScreenHost()
  strip.mount(host)
  strip.render(testContext(createState(), { now: Date.now() }))
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.ok(host.repaints > 0, 'the strip repaints itself while something is scrolling')

  strip.unmount()
  const settled = host.repaints
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(host.repaints, settled)
})
