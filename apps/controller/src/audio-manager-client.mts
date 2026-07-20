import net from 'node:net'

import type { AudioState } from './types.mjs'

/** One newline-delimited JSON message from the audio manager's socket. */
interface ManagerEvent {
  event?: string
  error?: string
  sources?: unknown
}

export interface AudioManagerClientOptions {
  socketPath: string
  onStateChange?: () => void
  reconnectMilliseconds?: number
  connectSocket?: (path: string) => net.Socket
  logger?: Pick<Console, 'log' | 'error'>
}

/**
 * Mirrors the audio manager's route state over its Unix control socket. The
 * cache updates optimistically so the Stream Deck reacts instantly and keeps
 * working while the manager restarts; reconnecting re-asserts the cached
 * toggles so user choices survive a manager restart within a boot.
 */
export class AudioManagerClient {
  state: AudioState = { sources: {} }
  connected = false

  private synced = false
  private buffer = ''
  private lastErrorMessage: string | null = null
  private socket: net.Socket | null = null
  private closed = false
  private reconnectTimer: NodeJS.Timeout | null = null
  private readonly socketPath: string
  private readonly onStateChange: () => void
  private readonly reconnectMilliseconds: number
  private readonly connectSocket: (path: string) => net.Socket
  private readonly logger: Pick<Console, 'log' | 'error'>

  constructor({
    socketPath,
    onStateChange = () => {},
    reconnectMilliseconds = 1000,
    connectSocket = (path) => net.createConnection(path),
    logger = console,
  }: AudioManagerClientOptions) {
    this.socketPath = socketPath
    this.onStateChange = onStateChange
    this.reconnectMilliseconds = reconnectMilliseconds
    this.connectSocket = connectSocket
    this.logger = logger
  }

  connect(): void {
    if (this.closed || this.socket) return
    const socket = this.connectSocket(this.socketPath)
    this.socket = socket
    this.buffer = ''
    socket.on('connect', () => {
      this.connected = true
      this.lastErrorMessage = null
      // A manager restart resets its in-memory routes to configured defaults;
      // re-assert our cache so user toggles survive within a boot. With no
      // cache yet, adopt whatever the manager has.
      this.write(this.synced
        ? { command: 'set-sources', sources: this.state.sources }
        : { command: 'get-state' })
      this.onStateChange()
    })
    socket.on('data', (chunk) => this.receive(String(chunk)))
    // Disconnects are normal and the close handler owns reconnection, but a
    // once-per-second retry loop repeating the same refusal would flood the
    // journal: log only when the failure changes, so a wrong socket path or
    // permission problem stays diagnosable.
    socket.on('error', (error: Error) => {
      if (error.message !== this.lastErrorMessage) {
        this.lastErrorMessage = error.message
        this.logger.error(`audio manager socket error: ${error.message}`)
      }
    })
    socket.on('close', () => {
      if (this.socket !== socket) return
      this.socket = null
      const wasConnected = this.connected
      this.connected = false
      if (wasConnected) this.onStateChange()
      if (this.closed) return
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null
        this.connect()
      }, this.reconnectMilliseconds)
    })
  }

  /**
   * Applies an on/off/toggle command to the local cache and forwards the
   * resolved absolute state, so a lost or replayed message can never invert a
   * toggle. Before the first authoritative state arrives the cache cannot
   * resolve a toggle, so the raw command is forwarded for the manager to
   * resolve against its own live state instead.
   */
  setSource(name: string, command: string): void {
    if (!this.synced) {
      this.write({ command: 'set-source', name, state: command })
      return
    }
    const enabled = command === 'toggle' ? !this.state.sources[name] : command === 'on'
    if (this.state.sources[name] !== enabled) {
      this.state = { sources: { ...this.state.sources, [name]: enabled } }
      this.onStateChange()
    }
    this.write({ command: 'set-source', name, state: enabled ? 'on' : 'off' })
  }

  close(): void {
    this.closed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.socket?.destroy()
  }

  private write(message: Record<string, unknown>): void {
    if (this.connected && this.socket) this.socket.write(`${JSON.stringify(message)}\n`)
  }

  private receive(chunk: string): void {
    this.buffer += chunk
    for (let index = this.buffer.indexOf('\n'); index >= 0; index = this.buffer.indexOf('\n')) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!line) continue
      let message: ManagerEvent
      try {
        message = JSON.parse(line) as ManagerEvent
      } catch {
        continue
      }
      if (message.event === 'state' && typeof message.sources === 'object'
          && message.sources !== null && !Array.isArray(message.sources)) {
        this.state = { sources: { ...(message.sources as AudioState['sources']) } }
        this.synced = true
        this.onStateChange()
      } else if (message.event === 'error') {
        this.logger.error(`audio manager rejected a command: ${message.error ?? 'unknown error'}`)
      }
    }
  }
}
