# Hardware

What to buy, what each part does, and the wiring rules that will bite you. The
settings named here are explained in [configuration](configuration.md).

## The parts list

| Part | Why | Where |
| --- | --- | --- |
| Raspberry Pi 5, Pi 4 Model B, or Pi Zero 2 W | Runs everything | [Pi 5](https://www.raspberrypi.com/products/raspberry-pi-5/) · [Pi 4 B](https://www.raspberrypi.com/products/raspberry-pi-4-model-b/) · [Zero 2 W](https://www.raspberrypi.com/products/raspberry-pi-zero-2-w/) |
| HiFiBerry DAC2 ADC Pro + AAmp60 | DAC with an analogue line-in, plus a bolt-on amplifier | [DAC2 ADC Pro](https://www.hifiberry.com/shop/boards/hifiberry-dac2-adc-pro/) · [AAmp60](https://www.hifiberry.com/shop/boards/aamp60/) |
| …or a HiFiBerry Amp100 | One board that is amplifier and DAC, no line-in | [Amp100](https://www.hifiberry.com/shop/boards/amp100/) |
| ReSpeaker XVF3800 USB 4-mic array | Wake word, far-field voice, echo cancellation, LED ring | [Seeed](https://www.seeedstudio.com/ReSpeaker-XVF3800-USB-Mic-Array-p-6488.html) |
| Elgato Stream Deck+ *(optional)* | Keys, dials, and a touch strip | [Elgato](https://www.elgato.com/us/en/p/stream-deck-plus-black) |
| Passive speakers | The point of the whole thing | anywhere |
| DC supply for the amplifier | Feeds the Pi through the GPIO header too | see [Power](#power) |
| Self-powered USB hub | Required on a Pi Zero 2 W, useful anywhere | anywhere |

Also: a microSD card and a 64-bit Raspberry Pi OS Lite install (Trixie or newer
for Sendspin; Bookworm works with `sendspin_enabled: false`).

## Which HiFiBerry board

`hifiberry_board` in inventory names the fitted board, because nothing can detect
it: the recipe sets `force_eeprom_read=0` so the chosen overlay wins over
whatever the HAT's EEPROM claims, and both boards enumerate as the same ALSA card.

| `hifiberry_board` | Board | Aux line-in | Amplifier mute |
| --- | --- | --- | --- |
| `dac2adcpro` | DAC2 ADC Pro with the AAmp60 amplifier on top | ✅ its ADC | — no control line |
| `amp100` | Amp100, amplifier and DAC in one | ❌ no ADC at all | ✅ `hifiberry_auto_mute` |

An Amp100 has no analogue input, so `smartamp_aux_enabled` is refused there, the
generated audio configuration carries no aux route, and the deck's AUX key draws
itself greyed out — the compiled layout needs no per-unit edit.

## Which Raspberry Pi

The board is read from `/proc/device-tree/model`. Everything it can do is
provisioned; anything it cannot is refused **by name** before provisioning
changes anything.

| | Pi 5 | Pi 4 Model B | Pi Zero 2 W |
| --- | --- | --- | --- |
| USB sound card (`usb_audio_gadget_enabled`) | ✅ | ✅ power-cut cable | ❌ only one data port |
| Sleep cuts USB power (`smartamp_sleep_usb_power_off`) | ✅ | ✅ VL805 fw `000137ad`+ | ❌ nothing to switch |
| Power button as sleep/wake toggle | ✅ | ❌ no button | ❌ no button |
| EEPROM power flags (`smartamp_power_off_on_halt`, `smartamp_wake_on_gpio`) | ✅ | ✅ | ❌ no bootloader EEPROM |
| `usb_audio_psu_max_current_ma` | ✅ | fixed ~1.2 A in hardware | n/a |

**Pi 4 B** switches VBUS through its VL805 hub across all four sockets at once,
but only on firmware `000137ad` or newer (`sudo rpi-eeprom-update`); older
firmware accepts the write and leaves the sockets lit. Its bootloader **ignores
`POWER_OFF_ON_HALT` whenever `WAKE_ON_GPIO` is set**, so the two are mutually
exclusive and preflight refuses the pair: keep `smartamp_wake_on_gpio` off for
the ~0W halt and start the board with a plug cycle, or keep GPIO3 as a wake path
and accept a halted board that never powers down. The same gap applies to sleep:
with the USB power-off flag on the deck is dark and **presence returning is the
only thing that wakes the board**.

**Pi Zero 2 W** has one micro-USB data port, so the deck, the ReSpeaker, and any
Ethernet adapter all arrive through a **self-powered hub** — which is also why it
cannot be a USB sound card. Nothing is switchable in sleep (the hub feeds the
devices), it boots from the card with no EEPROM at all, and its 512 MB is the
tightest RAM this stack runs in: leave `smartamp_zram_enabled` on.

The full capability table lives in
[`ansible/roles/smartamp/vars/boards.yml`](../ansible/roles/smartamp/vars/boards.yml).

## Power

⚡ Read this before switching the stack on.

Either amplifier board feeds the Pi from its own DC supply through the GPIO
header, so **size that supply for the whole stack**, not the amplifier alone. The
AAmp60's published power guarantee only covers Raspberry Pi models up to the Pi
4, and USB peripherals are tight either way: a Pi 5 exposes up to 1.6 A only with
a 5 A supply, and a Pi 4 B is fixed at roughly 1.2 A across all four USB-A ports.
Amplifier + XVF3800 + Stream Deck+ therefore needs validating on any board.

Run `sudo smartamp-doctor` on the Pi to read the throttle and under-voltage
flags, and add a powered USB hub if flags appear or USB devices reset. On a Pi
Zero 2 W the hub is mandatory and the budget is the hub's.

The bootloader power flags, standby, and what a halted board actually draws are
covered in [configuration → Power](configuration.md#power).

## Wiring the USB sound card

🔌 Turning on `usb_audio_gadget_enabled` makes the USB-C port a *peripheral*
port, so it can no longer be the PSU input — the Pi must be powered through the
HiFiBerry GPIO stack. Connect USB-C to the source computer; the USB-A ports stay
hosts for the ReSpeaker and the deck.

**On a Pi 4 B the host cable must have its power line cut.** That board wires
USB-C VBUS onto the same 5 V rail as the GPIO header with no PMIC to arbitrate,
so the computer and the amplifier would otherwise feed the rail against each
other. A Pi 5's PMIC arbitrates instead. A Pi Zero 2 W cannot do this at all, and
provisioning refuses the flag.

## Data sheets and upstream

- [HiFiBerry DAC2 ADC Pro data sheet](https://www.hifiberry.com/docs/data-sheets/datasheet-studio-dac-adc/)
- [HiFiBerry AAmp60 data sheet](https://www.hifiberry.com/docs/data-sheets/datasheet-aamp60/)
- [HiFiBerry Amp100 data sheet](https://www.hifiberry.com/docs/data-sheets/datasheet-amp100/)
- [HiFiBerry driver configuration on the Pi 5](https://www.hifiberry.com/blog/dac-pro-dac2-pro-dac-adc-pro-on-pi5/)
- [ReSpeaker XVF3800 guide and host controls](https://wiki.seeedstudio.com/respeaker_xvf3800_introduction/)
- [Linux Voice Assistant](https://github.com/OHF-Voice/linux-voice-assistant)
- [Raspberry Pi OTG white paper](https://pip-assets.raspberrypi.com/categories/685-app-notes-guides-whitepapers/documents/RP-009276-WP-1-Using%20OTG%20mode%20on%20Raspberry%20Pi%20SBCs)
