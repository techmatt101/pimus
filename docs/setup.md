# Setup

From a fresh Raspberry Pi OS Lite install to a working amp. Provisioning is
idempotent: run it as often as you like, and it applies later changes safely.

## 1. Prepare the Pi

Flash 64-bit **Raspberry Pi OS Lite** (Bookworm or Trixie; Trixie or newer for
Sendspin, which needs Python 3.12) with Raspberry Pi Imager, and in its advanced
options enable SSH and create your normal admin user. Nothing else is needed on
the Pi — it never gets Ansible, pnpm, or a TypeScript toolchain.

## 2. Prepare the control computer

This computer needs Python with Ansible, plus Node.js and
[pnpm](https://pnpm.io/installation) to compile the controller.

```sh
python3 -m pip install --user ansible
corepack enable pnpm   # or: npm install -g pnpm
make install
```

## 3. Describe your amps

- [`ansible/inventory/hosts.yml`](../ansible/inventory/hosts.yml) — one entry per
  unit. Its name is the hostname Ansible sets on the Pi; set `ansible_user` to
  the admin user you created.
- [`ansible/inventory/host_vars/`](../ansible/inventory/host_vars) — one short
  file per unit, holding only what makes it that unit: its HiFiBerry board,
  whether a deck is attached, the names it advertises, its power flags.
- [`ansible/inventory/group_vars/all.yml`](../ansible/inventory/group_vars/all.yml)
  — everything the units share, with every setting explained. The defaults are
  deliberately conservative: no deck, no USB sound card, no bootloader flags.

Anything the hardware cannot honour fails preflight **by name**, before
provisioning changes anything. See [hardware](hardware.md) and
[configuration](configuration.md).

## 4. Provision

```sh
ssh matt@office-amp.local   # accept the host key, then exit
make provision
make doctor                 # health report once it finishes
```

Boot-configuration changes trigger one reboot along the way.

## 5. Connect Home Assistant and Music Assistant

In Home Assistant, open **Settings → Devices & services**. Each unit's voice
satellite — named by `voice_assistant_name` in its `host_vars` — is discovered by
the ESPHome integration. Add it and pick an Assist pipeline. 🗣️

For Music Assistant, the Sendspin players appear on their own: the provider is
built in and mDNS discovery normally just works. If it does not, set
`sendspin_server_url` to the Music Assistant Sendspin WebSocket URL and provision
again.

Stream Deck keys that read house state need a second connection: set
`home_assistant_url` in inventory and put a long-lived access token in the Pi's
[secrets file](configuration.md#secrets). Without them those keys stay in place
and draw an unknown state.

This project installs no Home Assistant or Music Assistant server components.
Each amp is only a network audio/voice endpoint.

## Day to day

Every command that contacts a Pi runs against all of them; `LIMIT` names one or a
few:

```sh
make provision LIMIT=kitchen-amp
make deploy-controller LIMIT=office-amp,bedroom-amp
```

| Command | Does |
| --- | --- |
| `make provision` | Configure every Pi, rebooting when boot settings change |
| `make deploy-controller` | Rebuild and push **only** the controller to an already-provisioned Pi |
| `make doctor` | Run the diagnostic report on the Pi |
| `make verify` | Local checks, then inspect the configured Pi |
| `make check` | Ansible dry run |
| `make test` | Every local check, without contacting a Pi |
| `make playground` / `make dev` | Run the controller here against fake hardware — see [playground](playground.md) |
| `make update-versions` | Refresh every upstream version pin to the latest |

The Node controller changes more often than anything else, so
`make deploy-controller` recompiles and bundles the TypeScript, validates the
inventory, copies the bundles, dependencies, and generated `controller.json`, and
restarts `smartamp-controller` — without touching audio, voice, or boot
configuration. Use the full `make provision` after changing anything else.

Something wrong? [troubleshooting](troubleshooting.md), and `sudo smartamp-doctor`
on the Pi.
