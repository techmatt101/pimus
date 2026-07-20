.DEFAULT_GOAL := help

.PHONY: help install provision check verify doctor image-deps image

help:
	@awk 'BEGIN {FS = ":.*## "; printf "Usage: make <target>\n\n"} /^[a-zA-Z_-]+:.*## / {printf "  %-12s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install the Ansible collections on the control computer
	ansible-galaxy collection install -r requirements.yml

provision: ## Configure the Pi and reboot when boot settings change
	ansible-playbook playbooks/site.yml

check: ## Run an Ansible dry run (hardware/service tasks may be skipped)
	ansible-playbook playbooks/site.yml --check --diff

verify: ## Verify source syntax locally, then inspect the configured Pi
	python3 -m compileall -q roles/smartamp/files
	python3 -m unittest discover -s tests
	node --check roles/smartamp/files/streamdeck/index.mjs
	ansible-playbook playbooks/site.yml --syntax-check
	ansible-playbook playbooks/verify.yml

doctor: ## Run the diagnostic report on the Pi
	ansible smartamp -b -a smartamp-doctor

image-deps: ## Install rpi-image-gen host dependencies (Debian Linux)
	./image/build-image.sh --install-deps

image: ## Build a flashable Trixie arm64 image with first-boot provisioning
	./image/build-image.sh
