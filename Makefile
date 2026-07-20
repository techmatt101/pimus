.DEFAULT_GOAL := help

ANSIBLE_CONFIG := $(CURDIR)/ansible/ansible.cfg
export ANSIBLE_CONFIG

.PHONY: help install provision check verify doctor

help:
	@awk 'BEGIN {FS = ":.*## "; printf "Usage: make <target>\n\n"} /^[a-zA-Z_-]+:.*## / {printf "  %-12s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install the Ansible collections on the control computer
	ansible-galaxy collection install -r ansible/requirements.yml

provision: ## Configure the Pi and reboot when boot settings change
	ansible-playbook ansible/playbooks/site.yml

check: ## Run an Ansible dry run (hardware/service tasks may be skipped)
	ansible-playbook ansible/playbooks/site.yml --check --diff

verify: ## Verify source syntax locally, then inspect the configured Pi
	python3 -m compileall -q src/python
	python3 -m unittest discover -s tests
	node --check src/streamdeck/index.mjs
	ansible-playbook ansible/playbooks/site.yml --syntax-check
	ansible-playbook ansible/playbooks/verify.yml

doctor: ## Run the diagnostic report on the Pi
	ansible smartamp -b -a smartamp-doctor
