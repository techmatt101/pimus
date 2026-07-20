.DEFAULT_GOAL := help

ANSIBLE_CONFIG := $(CURDIR)/ansible/ansible.cfg
export ANSIBLE_CONFIG

.PHONY: help install build provision deploy-controller check test verify doctor

help:
	@awk 'BEGIN {FS = ":.*## "; printf "Usage: make <target>\n\n"} /^[a-zA-Z_-]+:.*## / {printf "  %-12s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install control computer dependencies (Ansible collections, controller toolchain)
	ansible-galaxy collection install -r ansible/requirements.yml
	cd apps/controller && npm ci

# The Pi never compiles anything; this produces the .mjs modules Ansible copies.
# Install the toolchain on demand so a fresh clone can build without make install.
build: ## Compile the TypeScript controller to apps/controller/dist
	cd apps/controller && [ -d node_modules ] || npm ci
	cd apps/controller && npm run build

provision: build ## Configure the Pi and reboot when boot settings change
	ansible-playbook ansible/playbooks/site.yml

# Runs only the controller-tagged tasks (plus preflight validation), so it needs
# a Pi that has already completed a full "make provision" at least once.
deploy-controller: build ## Rebuild and push only the controller to a provisioned Pi
	ansible-playbook ansible/playbooks/site.yml --tags controller

check: build ## Run an Ansible dry run (hardware/service tasks may be skipped)
	ansible-playbook ansible/playbooks/site.yml --check --diff

test: build ## Run local source and Ansible checks without contacting the Pi
	python3 -m compileall -q apps/audio-manager/src
	python3 -m unittest discover -s apps/audio-manager/test
	node --test $$(find apps/controller/dist/test -name '*.test.mjs' | sort)
	ansible-playbook ansible/playbooks/site.yml --syntax-check

verify: test ## Run local checks, then inspect the configured Pi
	ansible-playbook ansible/playbooks/verify.yml

doctor: ## Run the diagnostic report on the Pi
	ansible smartamp -b -a smartamp-doctor
