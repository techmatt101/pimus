.DEFAULT_GOAL := help

ANSIBLE_CONFIG := $(CURDIR)/ansible/ansible.cfg
export ANSIBLE_CONFIG

# Every target that contacts a Pi runs against all of them. Name one - or a
# comma-separated few - to work on a single amp:
#
#   make provision LIMIT=kitchen-amp
#   make deploy-controller LIMIT=office-amp,bedroom-amp
LIMIT ?=
ANSIBLE_LIMIT := $(if $(LIMIT),--limit $(LIMIT),)

.PHONY: help install build icons update-versions playground playground-check dev provision deploy-controller check test verify doctor

help:
	@awk 'BEGIN {FS = ":.*## "; printf "Usage: make <target>\n\n"} /^[a-zA-Z_-]+:.*## / {printf "  %-12s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install control computer dependencies (Ansible collections, Node workspace)
	ansible-galaxy collection install -r ansible/requirements.yml
	pnpm install --frozen-lockfile

# The Pi never compiles anything; this produces the modules Ansible copies.
# Install the toolchain on demand so a fresh clone can build without make install.
# tsc emits one .mjs per source, which is what the tests import and what the
# playground compiles against. The bundler then rolls that output into the three
# files a Pi is actually sent - core, deck addon, and what they share - and
# fails the build if deck code or its optional packages reach the core.
build: ## Compile and bundle the TypeScript controller to apps/controller/dist
	[ -d apps/controller/node_modules ] && [ -d node_modules/esbuild ] || pnpm install --frozen-lockfile
	pnpm --filter pimus-controller build
	node tools/bundle-controller.mjs

# Rewrites the committed icon set from only the icons listed in
# tools/generate-icons.mjs, read from the @hugeicons/core-free-icons
# devDependency. Needed only when adding an icon, never to build, test, or
# deploy; the icon package is installed on this computer and never on the Pi.
icons: ## Regenerate the Stream Deck icon set from Hugeicons
	[ -d node_modules/@hugeicons/core-free-icons ] || pnpm install --frozen-lockfile
	node tools/generate-icons.mjs

# Every upstream is pinned: release versions in the inventory, and a commit
# plus checksums (generated into the role's vars/main.yml) for xvf_host, whose
# upstream publishes no releases. This refreshes them all to the latest;
# review the diff, run `make test`, then provision to roll the Pi forward.
update-versions: ## Refresh every upstream version pin and checksum to the latest
	node tools/update-versions.mjs

# Development only. Runs the real controller against fake hardware and fake
# services, with the Stream Deck drawn in a browser; it never contacts the Pi.
playground: ## Run the controller locally with a fake Stream Deck in a browser
	[ -d apps/playground/node_modules ] || pnpm install --frozen-lockfile
	pnpm --filter pimus-playground start

# The exiting counterpart to "playground": type-checks the fakes against the
# controller sources without starting the server, so it can follow "make test".
playground-check: ## Type-check the playground against the controller sources
	[ -d apps/playground/node_modules ] || pnpm install --frozen-lockfile
	pnpm --filter pimus-playground typecheck

# Recompiles on every save, restarts the playground, and reloads the browser.
dev: ## Run the playground with live reload while you edit the controller
	[ -d apps/playground/node_modules ] || pnpm install --frozen-lockfile
	pnpm --filter pimus-playground dev

provision: build ## Configure every Pi and reboot when boot settings change
	ansible-playbook ansible/playbooks/site.yml $(ANSIBLE_LIMIT)

# Runs only the controller-tagged tasks (plus preflight validation), so it needs
# a Pi that has already completed a full "make provision" at least once.
deploy-controller: build ## Rebuild and push only the controller to a provisioned Pi
	ansible-playbook ansible/playbooks/site.yml --tags controller $(ANSIBLE_LIMIT)

check: build ## Run an Ansible dry run (hardware/service tasks may be skipped)
	ansible-playbook ansible/playbooks/site.yml --check --diff $(ANSIBLE_LIMIT)

test: build ## Run local source and Ansible checks without contacting the Pi
	@# The playground compiles the controller's sources and so must resolve the
	@# same packages; without this nothing would notice the two pins drifting.
	@# The deck-only packages are optional in the controller so a deck-less Pi
	@# never installs them, but the playground always draws, so it pins all of
	@# them as plain dependencies and both maps are compared against it.
	@python3 -c 'import json,sys; m=json.load(open("apps/controller/package.json")); c={**m["dependencies"], **m["optionalDependencies"]}; p=json.load(open("apps/playground/package.json"))["dependencies"]; d=sorted(k for k,v in c.items() if p.get(k)!=v); sys.exit(f"apps/playground pins different versions than apps/controller: {d}" if d else 0)'
	python3 -m compileall -q apps/audio-manager/src
	@# The LVA launcher adapter is a plain file too, and its upstream imports
	@# only exist on the Pi, so a syntax check is as far as this can go.
	python3 -m compileall -q ansible/roles/smartamp/files/smartamp_lva.py
	python3 -m unittest discover -s apps/audio-manager/test
	node --test $$(find apps/controller/dist/test -name '*.test.mjs' | sort)
	@# The tests import the tsc modules; the Pi runs the bundle, so check that
	@# artifact too. The entry can only be parsed - importing it would load
	@# /etc/smartamp/controller.json and start the daemon - while the deck bundle
	@# is imported outright, which is what proves it links and finds the font
	@# beside it. A font path that resolves to nothing registers nothing without
	@# raising, and the deck then draws blank labels, so assert the family.
	@# This is the one check that needs the deck's optional packages installed here.
	node --check apps/controller/dist/bundle/index.mjs
	cd apps/controller && node --input-type=module -e "import assert from 'node:assert/strict'; await import('./dist/bundle/streamdeck/control-surface.mjs'); const {GlobalFonts} = await import('@napi-rs/canvas'); assert.ok(GlobalFonts.families.some((f) => f.family === 'Deck'), 'the bundled font did not register')"
	@# The role's shell scripts are plain files (values injected via their unit's
	@# Environment=), so unlike the .j2 templates they can be statically checked.
	@command -v shellcheck >/dev/null || { echo "shellcheck is required for make test: brew install shellcheck (or apt-get install shellcheck)"; exit 1; }
	shellcheck ansible/roles/smartamp/files/scripts/*.sh
	ansible-playbook ansible/playbooks/site.yml --syntax-check

verify: test ## Run local checks, then inspect the configured Pi
	ansible-playbook ansible/playbooks/verify.yml $(ANSIBLE_LIMIT)

doctor: ## Run the diagnostic report on the Pi
	ansible smartamp $(ANSIBLE_LIMIT) -b -a smartamp-doctor
