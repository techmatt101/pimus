import WebSocket from 'ws'

import { applyLvaEvent } from './state.mjs'

export class LvaClient {
  constructor({
    uri,
    state,
    onStateChange = () => {},
    reconnectMilliseconds = 3000,
    WebSocketImpl = WebSocket,
    logger = console,
  }) {
    this.uri = uri
    this.state = state
    this.onStateChange = onStateChange
    this.reconnectMilliseconds = reconnectMilliseconds
    this.WebSocketImpl = WebSocketImpl
    this.logger = logger
    this.socket = null
    this.reconnectTimer = null
  }

  connect() {
    const socket = new this.WebSocketImpl(this.uri)
    this.socket = socket
    socket.on('open', () => this.logger.log('connected to voice assistant'))
    socket.on('message', (raw) => this.receive(raw))
    socket.on('close', () => {
      if (this.socket !== socket) return
      this.socket = null
      this.state.assist = 'DISCONNECTED'
      this.onStateChange()
      this.scheduleReconnect()
    })
    socket.on('error', () => {})
  }

  receive(raw) {
    try {
      applyLvaEvent(this.state, JSON.parse(raw.toString()))
      this.onStateChange()
    } catch (error) {
      this.logger.error('invalid voice event', error)
    }
  }

  send(command, data) {
    if (this.socket?.readyState !== this.WebSocketImpl.OPEN) return false
    this.socket.send(JSON.stringify({ command, ...(data ? { data } : {}) }))
    return true
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, this.reconnectMilliseconds)
  }
}
