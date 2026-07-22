#!/usr/bin/env node
// A dummy remote-tile client: the smallest useful example of the protocol the
// controller's remote-tile server speaks (apps/controller/src/remote/server.mts).
// It runs on the control computer, not the Pi, and puts one key on the deck's
// REMOTE page: an unread-message badge that grows every few seconds as if
// Slack messages were arriving, and clears when the key is pressed. The press
// also raises a banner on the touch strip, so both directions of the protocol
// are exercised.
//
// Point a real integration (a Slack listener, say) at the same four messages
// this file sends: hello, tile, notify, and the press events coming back.
//
//   pnpm --filter pimus-remote-demo start -- --token=<remote_tiles_token>
//
// Optional: --url=ws://office-amp.local:8470 (the default), --slot=0.

import { createCanvas } from '@napi-rs/canvas'
import WebSocket from 'ws'

const argument = (name, fallback) => {
  const match = process.argv.find((value) => value.startsWith(`--${name}=`))
  return match ? match.slice(name.length + 3) : fallback
}

const url = argument('url', process.env.SMARTAMP_REMOTE_URL || 'ws://office-amp.local:8470')
const token = argument('token', process.env.SMARTAMP_REMOTE_TOKEN || '')
const slot = Number(argument('slot', '0'))

if (!token) {
  console.error('Pass the shared token: --token=... (or set SMARTAMP_REMOTE_TOKEN).')
  console.error('It is remote_tiles_token in ansible/inventory/group_vars/all.yml.')
  process.exit(1)
}

const SLACK_PURPLE = '#4a154b'
/** How often another pretend message "arrives". */
const ARRIVAL_MS = 8000
const RECONNECT_MS = 3000

let unread = 0

/**
 * The key face as a 120x120 PNG: a white count in a badge when there is
 * anything unread, a quiet tick otherwise. The controller draws the caption
 * bar itself from the tile's label, so everything here sits above y=92.
 */
function badge() {
  const canvas = createCanvas(120, 120)
  const ctx = canvas.getContext('2d')
  const wash = ctx.createLinearGradient(0, 0, 0, 120)
  wash.addColorStop(0, '#6a2a6b')
  wash.addColorStop(1, SLACK_PURPLE)
  ctx.fillStyle = wash
  ctx.fillRect(0, 0, 120, 120)

  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  if (unread > 0) {
    ctx.fillStyle = '#e01e5a'
    ctx.beginPath()
    ctx.arc(60, 44, 30, 0, 2 * Math.PI)
    ctx.fill()
    ctx.fillStyle = '#ffffff'
    ctx.font = '600 34px sans-serif'
    ctx.fillText(unread > 99 ? '99+' : String(unread), 60, 46)
  } else {
    ctx.strokeStyle = '#9ad3a8'
    ctx.lineWidth = 6
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(42, 46)
    ctx.lineTo(56, 60)
    ctx.lineTo(80, 32)
    ctx.stroke()
  }
  return canvas.toBuffer('image/png').toString('base64')
}

function connect() {
  console.log(`connecting to ${url} ...`)
  const socket = new WebSocket(url)
  const send = (message) => socket.send(JSON.stringify(message))
  const sendTile = () => send({ type: 'tile', slot, label: 'SLACK', color: SLACK_PURPLE, image: badge() })
  let arrivals = null

  socket.on('open', () => send({ type: 'hello', token }))

  socket.on('message', (raw) => {
    const message = JSON.parse(String(raw))
    if (message.type === 'welcome') {
      console.log(`connected; slot ${slot} of ${message.slots} is ours`)
      sendTile()
      arrivals = setInterval(() => {
        unread += 1
        console.log(`a pretend message arrived; ${unread} unread`)
        sendTile()
      }, ARRIVAL_MS)
    } else if (message.type === 'press') {
      console.log(`key pressed on the deck; clearing ${unread} unread`)
      unread = 0
      sendTile()
      send({ type: 'notify', title: 'SLACK', message: 'INBOX CLEARED FROM THE DECK', color: SLACK_PURPLE, seconds: 4 })
    } else if (message.type === 'error') {
      console.error(`server refused a message: ${message.message}`)
    }
  })

  socket.on('close', (code, reason) => {
    if (arrivals) clearInterval(arrivals)
    // 4003 is the server refusing the hello: retrying cannot help a bad token.
    if (code === 4003) {
      console.error('the controller refused the token; check remote_tiles_token')
      process.exit(1)
    }
    console.log(`disconnected (${code} ${reason}); retrying in ${RECONNECT_MS / 1000}s`)
    setTimeout(connect, RECONNECT_MS)
  })
  socket.on('error', (error) => console.error(String(error)))
}

connect()
