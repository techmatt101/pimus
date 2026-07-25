const LEVELS = ['debug', 'info', 'warn', 'error'] as const

export type LogLevel = (typeof LEVELS)[number]

const configured = (process.env['SMARTAMP_LOG_LEVEL'] ?? 'info').toLowerCase() as LogLevel
const threshold = Math.max(0, LEVELS.indexOf(configured))

export interface Logger {
    debug(...parts: unknown[]): void
    info(...parts: unknown[]): void
    warn(...parts: unknown[]): void
    error(...parts: unknown[]): void
}

export function logger(component: string): Logger {
    const emit = (level: LogLevel, sink: (...parts: unknown[]) => void, parts: unknown[]): void => {
        if (LEVELS.indexOf(level) < threshold) return
        sink(`[${component}]`, ...parts)
    }
    return {
        debug: (...parts) => emit('debug', console.log, parts),
        info: (...parts) => emit('info', console.log, parts),
        warn: (...parts) => emit('warn', console.warn, parts),
        error: (...parts) => emit('error', console.error, parts),
    }
}
