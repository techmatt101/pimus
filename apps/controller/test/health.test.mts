import assert from 'node:assert/strict'
import test from 'node:test'

import {defaultRouteExists, HealthMonitor} from '../src/health.mjs'
import {ControlModel, createState} from '../src/state.mjs'

function makeMonitor(flags: {network: boolean; ha: boolean; audio: boolean; usbPlayback: boolean}) {
    const model = new ControlModel(createState())
    const posts: Array<Record<string, unknown>> = []
    const monitor = new HealthMonitor({
        model,
        notifications: {post: (data) => posts.push(data)},
        sources: {
            network: () => flags.network,
            ha: () => flags.ha,
            audio: () => flags.audio,
            usbPlayback: () => flags.usbPlayback,
        },
    })
    return {model, posts, monitor}
}

test('a loss banners after the first sample and a recovery does not', () => {
    const flags = {network: true, ha: true, audio: true, usbPlayback: false}
    const {model, posts, monitor} = makeMonitor(flags)

    monitor.sample()
    assert.equal(model.state.health.ha, true)
    assert.equal(posts.length, 0)

    flags.ha = false
    monitor.sample()
    assert.equal(model.state.health.ha, false)
    assert.equal(posts.length, 1)
    assert.equal(posts[0]?.title, 'HOME ASSISTANT')
    assert.equal(posts[0]?.message, 'LOST')

    flags.ha = true
    monitor.sample()
    assert.equal(model.state.health.ha, true)
    assert.equal(posts.length, 1)
})

test('a subsystem already down at boot shows without a banner burst', () => {
    const flags = {network: true, ha: false, audio: false, usbPlayback: false}
    const {model, posts, monitor} = makeMonitor(flags)

    monitor.sample()
    assert.equal(model.state.health.ha, false)
    assert.equal(model.state.health.audio, false)
    assert.equal(posts.length, 0)
})

test('usb playback starting moves state without a banner', () => {
    const flags = {network: true, ha: true, audio: true, usbPlayback: false}
    const {model, posts, monitor} = makeMonitor(flags)

    monitor.sample()
    flags.usbPlayback = true
    monitor.sample()
    assert.equal(model.state.health.usbPlayback, true)
    assert.equal(posts.length, 0)
})

test('the network probe reads the default route and fails open', () => {
    const table = 'Iface\tDestination\tGateway\nwlan0\t00000000\t0102A8C0\n'
    assert.equal(defaultRouteExists(() => table), true)
    assert.equal(defaultRouteExists(() => 'Iface\tDestination\nwlan0\t0102A8C0\n'), false)
    assert.equal(defaultRouteExists(() => {
        throw new Error('no proc')
    }), true)
})
