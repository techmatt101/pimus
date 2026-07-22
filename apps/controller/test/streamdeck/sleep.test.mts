import assert from 'node:assert/strict'
import test from 'node:test'

import { ControlModel, createState } from '../../src/state.mjs'
import { SleepController } from '../../src/streamdeck/sleep.mjs'
import { FakeHomeAssistant } from '../support/fixtures.mjs'

const PRESENCE = 'binary_sensor.office_presence'

/** Short enough that a test can outwait it, long enough not to race the runner. */
const GRACE = 15

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

interface Harness {
  model: ControlModel
  ha: FakeHomeAssistant
  sleep: SleepController
  /** How many times the panel state was published, to catch a notify loop. */
  notifications: () => number
}

function harness(presence: string, options: { presenceEntity?: string } = {}): Harness {
  const ha = new FakeHomeAssistant({ [PRESENCE]: { state: presence } })
  const model = new ControlModel(createState(), () => ({ sources: {} }))
  let notified = 0
  model.subscribe(() => { notified += 1 })
  const sleep = new SleepController({
    model,
    ha,
    presenceEntity: options.presenceEntity ?? PRESENCE,
    graceMilliseconds: GRACE,
  })
  sleep.start()
  return { model, ha, sleep, notifications: () => notified }
}

test('the panel sleeps once the room has been empty for the grace period', async () => {
  const { model, ha, sleep, notifications } = harness('on')
  assert.equal(model.state.awake, true, 'somebody is in the room')

  ha.put(PRESENCE, 'off')
  assert.equal(model.state.awake, true, 'the grace period has only just started')
  await delay(GRACE * 4)
  assert.equal(model.state.awake, false)

  // Walking back in lights it immediately, without waiting for anything.
  ha.put(PRESENCE, 'on')
  assert.equal(model.state.awake, true)

  // Writing `awake` back into the model re-enters the controller's own
  // subscription; it must settle rather than notify forever.
  assert.ok(notifications() < 10, `settled after ${notifications()} notifications`)
  sleep.stop()
})

test('a live Assist pipeline wakes the panel and restarts the grace period', async () => {
  const { model, ha, sleep } = harness('off')
  await delay(GRACE * 4)
  assert.equal(model.state.awake, false)

  // The wake word fired in an empty room: what Assist is doing has to be visible.
  model.state.assist = 'LISTENING'
  model.notify()
  assert.equal(model.state.awake, true)

  // A finished pipeline starts the countdown again rather than dropping it dark.
  model.state.assist = 'IDLE'
  model.notify()
  assert.equal(model.state.awake, true)
  await delay(GRACE * 4)
  assert.equal(model.state.awake, false)

  // A ticking timer is not a reason to burn the panel for its whole duration.
  model.state.assist = 'TIMER_TICKING'
  model.notify()
  assert.equal(model.state.awake, false)
  ha.put(PRESENCE, 'on')
  sleep.stop()
})

test('a hand on the deck wakes it, and that press does nothing else', async () => {
  const { model, sleep } = harness('off')
  await delay(GRACE * 4)
  assert.equal(model.state.awake, false)

  // The presence sensor still says the room is empty, and is simply wrong.
  assert.equal(sleep.touch(), true, 'the press was spent waking the panel')
  assert.equal(model.state.awake, true)

  // A second press is a real press, and keeps the panel up for another grace.
  assert.equal(sleep.touch(), false)
  assert.equal(model.state.awake, true)

  await delay(GRACE * 4)
  assert.equal(model.state.awake, false, 'the hand went away again')
  sleep.stop()
})

test('the panel stays lit whenever presence cannot be trusted', async () => {
  for (const presence of ['unknown', 'unavailable']) {
    const { model, sleep } = harness(presence)
    await delay(GRACE * 4)
    assert.equal(model.state.awake, true, `${presence} is not an empty room`)
    sleep.stop()
  }

  // Losing Home Assistant clears the entity cache; a dark panel that cannot be
  // explained is worse than a lit one that was not needed.
  const empty = harness('off')
  await delay(GRACE * 4)
  assert.equal(empty.model.state.awake, false)
  empty.ha.drop()
  assert.equal(empty.model.state.awake, true)
  empty.sleep.stop()

  // No configured sensor is not a deployment that sleeps at all.
  const unconfigured = harness('off', { presenceEntity: '' })
  await delay(GRACE * 4)
  assert.equal(unconfigured.model.state.awake, true)
  unconfigured.sleep.stop()
})
