// The playground's web front end: one static page, a server-sent-event stream
// carrying deck pixels, log lines and state, and a POST endpoint for the inputs
// the page triggers. Nothing here knows what a tile or a route is — it only
// moves messages between the bus and the browser.

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import type {Message, PlaygroundBus} from './bus.mjs'

// The page is read from the source tree on every request rather than copied
// into dist, so editing ui/index.html only needs a browser refresh. The hops
// climb out of dist/playground/src/ back to the app root.
const PAGE_PATH = fileURLToPath(new URL('../../../ui/index.html', import.meta.url))

/**
 * How long a browser waits before reconnecting a dropped stream. Short, because
 * this is exactly the gap while `pnpm dev` restarts the process: the page is
 * back before anyone notices, and the reconnect is what triggers its reload.
 */
const RECONNECT_MILLISECONDS = 400

/** Coalesces the several events an editor emits for one save. */
const WATCH_SETTLE_MILLISECONDS = 100

/** Everything the browser can ask the fake hardware and services to do. */
export type PlaygroundInput =
    | { kind: 'key'; index: number }
    | { kind: 'dial'; index: number; direction: 'left' | 'right' | 'press' }
    | { kind: 'lcd'; x: number }
    | { kind: 'event'; event: string; data?: Record<string, unknown> }
    | { kind: 'deck'; plugged: boolean }
    | { kind: 'drop'; target: 'lva' | 'audio' }
    | { kind: 'notify'; data?: Record<string, unknown> }
    | { kind: 'simulate'; enabled: boolean }

export interface PlaygroundServerOptions {
    bus: PlaygroundBus
    onInput: (input: PlaygroundInput) => void
    port?: number
}

export class PlaygroundServer {
    readonly port: number
    /**
     * Identifies this process to the browser. A page that reconnects and finds a
     * different id knows the playground restarted under it — which is how a
     * rebuilt controller ends up on screen without anyone pressing reload.
     */
    readonly bootId = `${process.pid}-${Date.now()}`
    private readonly server: http.Server
    private readonly streams = new Set<http.ServerResponse>()
    private pageWatcher: fs.FSWatcher | null = null
    private watchTimer: NodeJS.Timeout | null = null

    constructor({bus, onInput, port = 8787}: PlaygroundServerOptions) {
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

    /** How many browsers are currently attached to the event stream. */
    get clients(): number {
        return this.streams.size
    }

    async start(): Promise<string> {
        await new Promise<void>((resolve, reject) => {
            this.server.once('error', reject)
            this.server.listen(this.port, '127.0.0.1', () => resolve())
        })
        this.watchPage()
        return `http://127.0.0.1:${this.port}/`
    }

    close(): void {
        if (this.watchTimer) clearTimeout(this.watchTimer)
        this.pageWatcher?.close()
        for (const stream of this.streams) stream.end()
        this.server.close()
    }

    /**
     * Reloads open pages when the page source changes. The directory is watched
     * rather than the file, because an editor that saves by renaming replaces the
     * inode a single-file watch is holding.
     */
    private watchPage(): void {
        const directory = path.dirname(PAGE_PATH)
        const name = path.basename(PAGE_PATH)
        try {
            this.pageWatcher = fs.watch(directory, (_event, changed) => {
                if (changed !== null && changed !== name) return
                if (this.watchTimer) clearTimeout(this.watchTimer)
                this.watchTimer = setTimeout(() => {
                    this.watchTimer = null
                    this.push({type: 'reload'})
                }, WATCH_SETTLE_MILLISECONDS)
                this.watchTimer.unref()
            })
        } catch {
            // Watching is a convenience; a missing inotify watch must not stop the
            // playground from running.
        }
    }

    private page(response: http.ServerResponse): void {
        fs.promises.readFile(PAGE_PATH).then(
            (body) => {
                response.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'})
                response.end(body)
            },
            () => {
                response.writeHead(500, {'content-type': 'text/plain'})
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
        // Browsers wait three seconds before retrying by default, which is most of
        // a restart spent staring at a dead page.
        response.write(`retry: ${RECONNECT_MILLISECONDS}\n\n`)
        this.streams.add(response)
        response.write(`data: ${JSON.stringify({type: 'hello', bootId: this.bootId} satisfies Message)}\n\n`)
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
                response.writeHead(400, {'content-type': 'text/plain'})
                response.end(String(error))
            }
        })
    }

    private notFound(response: http.ServerResponse): void {
        response.writeHead(404, {'content-type': 'text/plain'})
        response.end('not found\n')
    }

    private push(message: Message): void {
        const frame = `data: ${JSON.stringify(message)}\n\n`
        for (const stream of this.streams) stream.write(frame)
    }
}
