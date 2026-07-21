.DEFAULT_GOAL := help

ANSIBLE_CONFIG := $(CURDIR)/ansible/ansible.cfg
export ANSIBLE_CONFIG

.PHONY: help install build playground dev provision deploy-controller check test verify doctor

help:
	@awk 'BEGIN {FS = ":.*## "; printf "Usage: make <target>\n\n"} /^[a-zA-Z_-]+:.*## / {printf "  %-12s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install control computer dependencies (Ansible collections, Node workspace)
	ansible-galaxy collection install -r ansible/requirements.yml
	pnpm install --frozen-lockfile

# The Pi never compiles anything; this produces the .mjs modules Ansible copies.
# Install the toolchain on demand so a fresh clone can build without make install.
build: ## Compile the TypeScript controller to apps/controller/dist
	[ -d apps/controller/node_modules ] || pnpm install --frozen-lockfile
	pnpm --filter pimus-controller build

# Development only. Runs the real controller against fake hardware and fake
# services, with the Stream Deck drawn in a browser; it never contacts the Pi.
playground: ## Run the controller locally with a fake Stream Deck in a browser
	[ -d apps/playground/node_modules ] || pnpm install --frozen-lockfile
	pnpm --filter pimus-playground start

# Recompiles on every save, restarts the playground, and reloads the browser.
dev: ## Run the playground with live reload while you edit the controller
	[ -d apps/playground/node_modules ] || pnpm install --frozen-lockfile
	pnpm --filter pimus-playground dev

provision: build ## Configure the Pi and reboot when boot settings change
	ansible-playbook ansible/playbooks/site.yml

# Runs only the controller-tagged tasks (plus preflight validation), so it needs
# a Pi that has already completed a full "make provision" at least once.
deploy-controller: build ## Rebuild and push only the controller to a provisioned Pi
	ansible-playbook ansible/playbooks/site.yml --tags controller

check: build ## Run an Ansible dry run (hardware/service tasks may be skipped)
	ansible-playbook ansible/playbooks/site.yml --check --diff

test: build ## Run local source and Ansible checks without contacting the Pi
	@# The playground compiles the controller's sources and so must resolve the
	@# same packages; without this nothing would notice the two pins drifting.
	@python3 -c 'import json,sys; c=json.load(open("apps/controller/package.json"))["dependencies"]; p=json.load(open("apps/playground/package.json"))["dependencies"]; d=sorted(k for k,v in c.items() if p.get(k)!=v); sys.exit(f"apps/playground pins different versions than apps/controller: {d}" if d else 0)'
	python3 -m compileall -q apps/audio-manager/src
	python3 -m unittest discover -s apps/audio-manager/test
	node --test $$(find apps/controller/dist/test -name '*.test.mjs' | sort)
	ansible-playbook ansible/playbooks/site.yml --syntax-check

verify: test ## Run local checks, then inspect the configured Pi
	ansible-playbook ansible/playbooks/verify.yml

doctor: ## Run the diagnostic report on the Pi
	ansible smartamp -b -a smartamp-doctor
