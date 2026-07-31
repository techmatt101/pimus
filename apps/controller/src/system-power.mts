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
    #ending = false
    readonly #run: Run
    readonly #errors: Pick<Console, 'error'>

    constructor({run = runCommand, errors = console}: SystemPowerOptions = {}) {
        this.#run = run
        this.#errors = errors
    }

    shutdown(): void {
        this.#end('poweroff', 'halting the system')
    }

    reboot(): void {
        this.#end('reboot', 'rebooting the system')
    }

    // One latch for both: whichever ends the session first, the second request
    // would only race a board that is already on its way down.
    #end(command: string, message: string): void {
        if (this.#ending) return
        this.#ending = true
        log.info(message)
        void this.#run('systemctl', [command]).catch((error: unknown) => {
            this.#ending = false
            this.#errors.error(`${command} failed`, error)
        })
    }
}
