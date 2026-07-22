import assert from 'node:assert/strict'
import test from 'node:test'

import { NOTIFY_EVENT, NotificationCenter } from '../../src/home-assistant/notifications.mjs'
import { FakeHomeAssistant } from '../support/fixtures.mjs'

const quiet = { log: () => {} }

const centerOver = (ha: FakeHomeAssistant, onChange = (): void => {}): NotificationCenter => {
  const center = new NotificationCenter({ ha, onChange, logger: quiet })
  center.start()
  return center
}

test('an automation firing the event puts a message on the strip', () => {
  const ha = new FakeHomeAssistant()
  let changes = 0
  const center = centerOver(ha, () => { changes += 1 })

  assert.equal(center.current(0), undefined, 'nothing to show until something fires')
  ha.fire(NOTIFY_EVENT, { title: 'front door', message: 'someone is at the door', color: '#b71c1c', seconds: 10 })
  assert.equal(changes, 1, 'the deck is told to repaint on arrival')

  const shown = center.current(1000)
  assert.deepEqual(
    { title: shown?.title, message: shown?.message, color: shown?.color },
    { title: 'front door', message: 'someone is at the door', color: '#b71c1c' },
  )
  // The clock starts when the strip first shows it, not when it arrived.
  assert.equal(shown?.shownAt, 1000)
  assert.equal(shown?.expiresAt, 11_000)
  assert.equal(center.current(10_999)?.message, 'someone is at the door')
  assert.equal(center.current(11_000), undefined, 'it hands the strip back when its time is up')
})

test('messages queue rather than overwrite, and each gets its full time', () => {
  const ha = new FakeHomeAssistant()
  const center = centerOver(ha)

  ha.fire(NOTIFY_EVENT, { message: 'washing machine has finished', seconds: 5 })
  ha.fire(NOTIFY_EVENT, { message: 'someone is at the door', seconds: 5 })

  assert.equal(center.current(0)?.message, 'washing machine has finished')
  assert.equal(center.current(4_999)?.message, 'washing machine has finished')

  // The second message only starts counting once it is the one being shown.
  const second = center.current(5_000)
  assert.equal(second?.message, 'someone is at the door')
  assert.equal(second?.expiresAt, 10_000)
  assert.equal(center.current(10_000), undefined)
})

test('a tap acknowledges what is showing and lets the next one through', () => {
  const ha = new FakeHomeAssistant()
  const center = centerOver(ha)
  ha.fire(NOTIFY_EVENT, { message: 'first' })
  ha.fire(NOTIFY_EVENT, { message: 'second' })

  assert.equal(center.current(0)?.message, 'first')
  center.dismiss()
  assert.equal(center.current(10)?.message, 'second', 'the queue is not cleared by acknowledging one')
  center.dismiss()
  assert.equal(center.current(20), undefined)
})

test('an incomplete or hostile payload cannot break the strip', () => {
  const ha = new FakeHomeAssistant()
  const center = centerOver(ha)

  // Nothing to say means nothing is shown, rather than a blank banner.
  ha.fire(NOTIFY_EVENT, {})
  ha.fire(NOTIFY_EVENT, { message: '   ' })
  ha.fire(NOTIFY_EVENT, { message: { text: 'nope' } })
  assert.equal(center.current(0), undefined)

  // A title on its own is the message: an automation should not have to know
  // which of the two fields the strip prefers.
  ha.fire(NOTIFY_EVENT, { title: 'washing machine has finished' })
  const titleOnly = center.current(0)
  assert.equal(titleOnly?.message, 'washing machine has finished')
  assert.equal(titleOnly?.title, '', 'one line of text is the message, with no heading')
  center.dismiss()

  // A bad duration falls back to the default rather than expiring instantly or
  // parking the banner over the strip forever.
  ha.fire(NOTIFY_EVENT, { message: 'a', seconds: 'soon' })
  assert.ok((center.current(0)?.expiresAt ?? 0) > 0)
  center.dismiss()
  ha.fire(NOTIFY_EVENT, { message: 'b', seconds: 99_999 })
  assert.ok((center.current(0)?.expiresAt ?? 0) <= 120_000)
})

test('a runaway automation cannot grow the queue without bound', () => {
  const ha = new FakeHomeAssistant()
  const center = centerOver(ha)
  for (let index = 0; index < 50; index += 1) ha.fire(NOTIFY_EVENT, { message: `message ${index}` })

  let shown = 0
  let now = 0
  while (center.current(now)) {
    shown += 1
    center.dismiss()
    now += 1
  }
  assert.ok(shown <= 9, `queued ${shown} messages`)
})

test('stopping drops the subscription', () => {
  const ha = new FakeHomeAssistant()
  const center = centerOver(ha)
  center.stop()
  ha.fire(NOTIFY_EVENT, { message: 'someone is at the door' })
  assert.equal(center.current(0), undefined)
})
