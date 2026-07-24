import assert from 'node:assert/strict'
import test from 'node:test'

import {encodePayload, Xvf3800Device} from '../../src/voice/xvf3800-device.mjs'
import type {UsbControlDevice} from '../../src/types.mjs'
import {LED_COUNT, LedEffect} from '../../src/types.mjs'

test('XVF3800 commands use vendor transfers and little-endian payloads', async () => {
    const transfers: unknown[][] = []
    const usbDevice: UsbControlDevice & { openCalls: number } = {
        openCalls: 0,
        timeout: 0,
        open() {
            this.openCalls += 1
        },
        close() {
        },
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

    await device.apply({
        effect: LedEffect.Doa,
        brightness: 64,
        speed: 2,
        color: 0x102030,
        direction: {base: 0x102030, highlight: 0xa0b0c0},
    })

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
    await device.apply({
        effect: LedEffect.Ring,
        brightness: 64,
        speed: 2,
        color: 0x102030,
        ring: Array(LED_COUNT).fill(0x010203),
    })
    // Brightness, speed, and colour are unchanged, so only the ring colours and
    // the effect are transferred.
    assert.deepEqual(transfers.map((entry) => entry.slice(0, 4)), [
        [0x40, 0, 19, 20],
        [0x40, 0, 12, 20],
    ])
    assert.deepEqual(
        [...(transfers[0]?.[4] as Buffer)],
        Array(LED_COUNT).fill([0x03, 0x02, 0x01, 0]).flat(),
    )
    assert.deepEqual([...encodePayload('uint8', [-1, 256])], [0, 255])
})

