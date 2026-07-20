import assert from 'node:assert/strict'
import test from 'node:test'

import { encodePayload, rgb, Xvf3800Device } from '../../src/voice/xvf3800-device.mjs'
import type { UsbControlDevice } from '../../src/types.mjs'

test('XVF3800 commands use vendor transfers and little-endian payloads', async () => {
  const transfers: unknown[][] = []
  const usbDevice: UsbControlDevice & { openCalls: number } = {
    openCalls: 0,
    timeout: 0,
    open() { this.openCalls += 1 },
    close() {},
    controlTransfer(...args: unknown[]) {
      const callback = args.pop() as (error: unknown) => void
      transfers.push(args)
      callback(null)
    },
  }
  const device = new Xvf3800Device({
    vendorId: 0x2886,
    productId: 0x001a,
    findDevice: () => usbDevice,
  })

  await device.apply({ effect: 'doa', color: '#102030', accent: '#a0b0c0' }, 64, 2)

  assert.equal(usbDevice.openCalls, 1)
  assert.deepEqual(transfers.map((entry) => entry.slice(0, 4)), [
    [0x40, 0, 13, 20],
    [0x40, 0, 15, 20],
    [0x40, 0, 16, 20],
    [0x40, 0, 17, 20],
    [0x40, 0, 12, 20],
  ])
  assert.deepEqual([...(transfers[3]?.[4] as Buffer)], [0x30, 0x20, 0x10, 0, 0xc0, 0xb0, 0xa0, 0])

  transfers.length = 0
  await device.apply({ effect: 'ring', color: '#010203' }, 32, 1)
  assert.deepEqual(transfers.map((entry) => entry.slice(0, 4)), [
    [0x40, 0, 13, 20],
    [0x40, 0, 15, 20],
    [0x40, 0, 16, 20],
    [0x40, 0, 19, 20],
    [0x40, 0, 12, 20],
  ])
  assert.deepEqual(
    [...(transfers[3]?.[4] as Buffer)],
    Array(12).fill([0x03, 0x02, 0x01, 0]).flat(),
  )
  assert.equal(rgb('#abcdef'), 0xabcdef)
  assert.deepEqual([...encodePayload('uint8', [-1, 256])], [0, 255])
})

test('a failed transfer drops the handle so the next write reconnects', async () => {
  let opens = 0
  let closes = 0
  let failNext = true
  const usbDevice: UsbControlDevice = {
    timeout: 0,
    open() { opens += 1 },
    close() { closes += 1 },
    controlTransfer(...args: unknown[]) {
      const callback = args.pop() as (error: unknown) => void
      if (failNext) {
        failNext = false
        callback(new Error('LIBUSB_ERROR_NO_DEVICE'))
        return
      }
      callback(null)
    },
  }
  const device = new Xvf3800Device({
    vendorId: 0x2886,
    productId: 0x001a,
    findDevice: () => usbDevice,
  })

  await assert.rejects(device.write('LED_EFFECT', [1]), /LIBUSB_ERROR_NO_DEVICE/)
  assert.equal(closes, 1)

  // A re-enumerated device must be reopened rather than reusing a dead handle.
  await device.write('LED_EFFECT', [1])
  assert.equal(opens, 2)
})
