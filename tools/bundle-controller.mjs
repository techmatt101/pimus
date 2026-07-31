#!/usr/bin/env node
// Rolls the compiled controller up into the handful of files Ansible deploys.
// Run by `make build` straight after tsc; never on the Pi.
//
// tsc emits ~75 .mjs modules, and the role copied them one at a time — a
// separate remote invocation per file, which is most of what a controller
// deploy spent its time on. esbuild links them into one bundle per deployment
// boundary instead:
//
//   dist/bundle/index.mjs                      the core daemon
//   dist/bundle/streamdeck/control-surface.mjs the deck addon, behind the
//                                              dynamic import in index.mts
//   dist/bundle/shared-<hash>.mjs              what both of them use
//
// The input is tsc's JS output rather than the .mts sources, so no TypeScript
// semantics are involved here and the deployed bytes come from the same emit
// the tests and the playground type-check.
//
// Splitting is what keeps this correct: a shared module must exist once, or
// there would be two ControlModel classes and `instanceof HomeAssistantClient`
// in index.mts would start answering no. The chunk keeps its content hash so a
// half-finished deploy fails loudly with ERR_MODULE_NOT_FOUND instead of
// running one new half against one old one.
//
// Everything the deck boundary used to get from Ansible skipping files by path
// is asserted below against the real import graph.

import {rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'

import {build} from 'esbuild'

const CONTROLLER = new URL('../apps/controller/', import.meta.url)

const CORE = 'dist/bundle/index.mjs'
const DECK = 'dist/bundle/streamdeck/control-surface.mjs'
const CHUNK = /^dist\/bundle\/shared-[A-Z0-9]+\.mjs$/

/** Reached only through streamdeck/control-surface.mjs, and a deck-less Pi is sent neither. */
const DECK_ONLY = /^dist\/src\/(streamdeck|remote)\//

/**
 * The manifest's optionalDependencies. A deck-less Pi installs with
 * --omit=optional, so any of these reachable from the core bundle would be code
 * that cannot load beside packages that are not there.
 */
const OPTIONAL_PACKAGES = ['@napi-rs/canvas', '@elgato-stream-deck/node', '@julusian/jpeg-turbo']

/**
 * surface.mjs registers the bundled font from a path relative to its own
 * module, so which output it lands in decides how deep that path resolves.
 */
const FONT_MODULE = 'dist/src/streamdeck/surface.mjs'

// A previous run's chunk carries a different hash, and the role deploys every
// .mjs it finds here, so a stale one would be shipped alongside the current one.
await rm(new URL('dist/bundle', CONTROLLER), {recursive: true, force: true})

const {metafile} = await build({
    absWorkingDir: fileURLToPath(CONTROLLER),
    entryPoints: ['dist/src/index.mjs', 'dist/src/streamdeck/control-surface.mjs'],
    outbase: 'dist/src',
    outdir: 'dist/bundle',
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    // usb and ws are installed on the Pi, the three deck packages are installed
    // when it has a deck, and all five are native or CommonJS. Bundling any of
    // them would break the load, not speed it up.
    packages: 'external',
    sourcemap: true,
    minify: false,
    chunkNames: 'shared-[hash]',
    outExtension: {'.js': '.mjs'},
    metafile: true,
    logLevel: 'warning',
})

const outputs = Object.entries(metafile.outputs).filter(([name]) => !name.endsWith('.map'))
const chunks = outputs.map(([name]) => name).filter((name) => CHUNK.test(name))
const problems = []

const expected = [CORE, DECK, ...chunks].sort()
const produced = outputs.map(([name]) => name).sort()
if (chunks.length !== 1 || produced.join() !== expected.join()) {
    problems.push(`expected ${CORE}, ${DECK} and one shared chunk, got: ${produced.join(', ')}`)
}

const owner = new Map()
for (const [name, output] of outputs) {
    for (const input of Object.keys(output.inputs)) {
        const first = owner.get(input)
        if (first) {
            problems.push(`${input} is in both ${first} and ${name}; splitting must give it one home`)
        } else {
            owner.set(input, name)
        }
    }
}

for (const [name, output] of outputs) {
    if (name === DECK) continue
    for (const input of Object.keys(output.inputs)) {
        if (DECK_ONLY.test(input)) {
            problems.push(`${input} reached ${name}; only ${DECK} may hold streamdeck/ or remote/ code`)
        }
    }
    for (const {path} of output.imports) {
        if (OPTIONAL_PACKAGES.includes(path)) {
            problems.push(`${name} imports ${path}, which a deck-less Pi does not install`)
        }
    }
}

if (owner.get(FONT_MODULE) !== DECK) {
    problems.push(
        `${FONT_MODULE} must be in ${DECK}: it resolves ../../assets/fonts against its own module,`
        + ' and from any other depth that silently registers nothing and the deck draws blank labels',
    )
}

if (problems.length > 0) {
    console.error('The controller bundle broke a deployment boundary:')
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
}

for (const [name, output] of outputs.sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`${name} ${(output.bytes / 1024).toFixed(1)}KB (${Object.keys(output.inputs).length} modules)`)
}
