import WebSocket from 'ws'

import { applyLvaEvent } from './state.mjs'

export class LvaClient {
  constructor({
    uri,
    state,
    onStateChange = () => {},
    onOpen = () => {},
    onEvent = () => {},
    onDisconnect = () => {},
    reconnectMilliseconds = 3000,
    WebSocketImpl = WebSocket,
    logger = console,
  }) {
    this.uri = uri
    this.state = state
    this.onStateChange = onStateChange
    this.onOpen = onOpen
    this.onEvent = onEvent
    this.onDisconnect = onDisconnect
    this.reconnectMilliseconds = reconnectMilliseconds
    this.WebSocketImpl = WebSocketImpl
    this.logger = logger
    this.socket = null
    this.reconnectTimer = null
  }

  connect() {
    const socket = new this.WebSocketImpl(this.uri)
    this.socket = socket
    socket.on('open', () => {
      this.logger.log('connected to voice assistant')
      Promise.resolve(this.onOpen()).catch((error) => this.logger.error('voice connection hook failed', error))
    })
    socket.on('message', (raw) => this.receive(raw))
    socket.on('close', () => {
      if (this.socket !== socket) return
      this.socket = null
      this.state.assist = 'DISCONNECTED'
      Promise.resolve(this.onDisconnect()).catch((error) => this.logger.error('voice disconnect hook failed', error))
      this.onStateChange()
      this.scheduleReconnect()
    })
    socket.on('error', () => {})
  }

  receive(raw) {
    try {
      const message = JSON.parse(raw.toString())
      applyLvaEvent(this.state, message)
      Promise.resolve(this.onEvent(message)).catch((error) => this.logger.error('voice event hook failed', error))
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
