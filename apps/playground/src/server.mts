// The playground's web front end: one static page, a server-sent-event stream
// carrying deck pixels, log lines and state, and a POST endpoint for the inputs
// the page triggers. Nothing here knows what a tile or a route is — it only
// moves messages between the bus and the browser.

import fs from 'node:fs'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

import type { Message, PlaygroundBus } from './bus.mjs'

// The page is read from the source tree on every request rather than copied
// into dist, so editing ui/index.html only needs a browser refresh. The hops
// climb out of dist/playground/src/ back to the app root.
const PAGE_PATH = fileURLToPath(new URL('../../../ui/index.html', import.meta.url))

/** Everything the browser can ask the fake hardware and services to do. */
export type PlaygroundInput =
  | { kind: 'key'; index: number }
  | { kind: 'dial'; index: number; direction: 'left' | 'right' | 'press' }
  | { kind: 'lcd'; x: number }
  | { kind: 'event'; event: string; data?: Record<string, unknown> }
  | { kind: 'deck'; plugged: boolean }
  | { kind: 'drop'; target: 'lva' | 'audio' }
  | { kind: 'simulate'; enabled: boolean }

export interface PlaygroundServerOptions {
  bus: PlaygroundBus
  onInput: (input: PlaygroundInput) => void
  port?: number
}

export class PlaygroundServer {
  readonly port: number
  private readonly server: http.Server
  private readonly streams = new Set<http.ServerResponse>()

  constructor({ bus, onInput, port = 8787 }: PlaygroundServerOptions) {
    this.port = port
    this.server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (url.pathname === '/events') this.stream(bus, response)
      else if (url.pathname === '/input' && request.method === 'POST') this.input(request, response, onInput)
      else if (url.pathname === '/') this.page(response)
      else this.notFound(response)
    })
    bus.on('message', (message: Message) => this.push(message))
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.port, '127.0.0.1', () => resolve())
    })
    return `http://127.0.0.1:${this.port}/`
  }

  close(): void {
    for (const stream of this.streams) stream.end()
    this.server.close()
  }

  private page(response: http.ServerResponse): void {
    fs.promises.readFile(PAGE_PATH).then(
      (body) => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        response.end(body)
      },
      () => {
        response.writeHead(500, { 'content-type': 'text/plain' })
        response.end(`Playground page missing at ${PAGE_PATH}\n`)
      },
    )
  }

  private stream(bus: PlaygroundBus, response: http.ServerResponse): void {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    })
    this.streams.add(response)
    // A page opened mid-session catches up on the current deck face, state and
    // recent log instead of waiting for the next change.
    for (const message of bus.replay()) response.write(`data: ${JSON.stringify(message)}\n\n`)
    response.on('close', () => {
      this.streams.delete(response)
    })
  }

  private input(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    onInput: (input: PlaygroundInput) => void,
  ): void {
    let body = ''
    request.on('data', (chunk) => {
      body += String(chunk)
    })
    request.on('end', () => {
      try {
        onInput(JSON.parse(body) as PlaygroundInput)
        response.writeHead(204).end()
      } catch (error) {
        response.writeHead(400, { 'content-type': 'text/plain' })
        response.end(String(error))
      }
    })
  }

  private notFound(response: http.ServerResponse): void {
    response.writeHead(404, { 'content-type': 'text/plain' })
    response.end('not found\n')
  }

  private push(message: Message): void {
    const frame = `data: ${JSON.stringify(message)}\n\n`
    for (const stream of this.streams) stream.write(frame)
  }
}
