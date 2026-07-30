import {spawn} from 'node:child_process'

import {logger} from './log.mjs'

const log = logger('system-power')

type Run = (command: string, args: readonly string[]) => Promise<void>

const runCommand: Run = (command, args) =>
    new Promise((resolve, reject) => {
        const child = spawn(command, args, {stdio: 'ignore'})
        child.on('error', reject)
        child.on('exit', (code) => {
            if (code === 0) resolve()
            else reject(new Error(`${command} ${args.join(' ')} exited with ${String(code)}`))
        })
    })

export interface SystemPowerOptions {
    run?: Run
    errors?: Pick<Console, 'error'>
}

// The unit runs as the service account under NoNewPrivileges, so nothing here
// escalates: systemctl hands the request to logind over D-Bus and the polkit
// rule Ansible deploys is what allows it. A refused or failed request unlatches
// so the key can be pressed again.
export class SystemPower {
    #halting = false
    readonly #run: Run
    readonly #errors: Pick<Console, 'error'>

    constructor({run = runCommand, errors = console}: SystemPowerOptions = {}) {
        this.#run = run
        this.#errors = errors
    }

    shutdown(): void {
        if (this.#halting) return
        this.#halting = true
        log.info('halting the system')
        void this.#run('systemctl', ['poweroff']).catch((error: unknown) => {
            this.#halting = false
            this.#errors.error('poweroff failed', error)
        })
    }
}
