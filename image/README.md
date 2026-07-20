# Flashable image build

The main workflow provisions an existing Raspberry Pi OS Lite install over SSH. For repeatable blank-card builds, this directory adds the same project as a first-boot recipe to Raspberry Pi's official `rpi-image-gen` v2.6.0.

Use a Debian Bookworm or Trixie Linux build host. Native arm64 is Raspberry Pi's supported path; x86-64 can require QEMU, binfmt and additional privileges.

```sh
make image-deps
SMARTAMP_SSH_PUBKEY_FILE=/path/to/id_ed25519.pub make image
```

The result is copied to `artifacts/images/pimus-office-amp.img.zst`. Decompress it and flash it with Raspberry Pi Imager. The image contains a locked-password `matt` admin account with the supplied SSH key. Change `device.user1` in `image/config/smartamp.yaml` if desired.

Connect Ethernet for the first boot. The image starts a one-time Ansible service that installs current Debian packages, the pinned native Linux Voice Assistant client, and Node dependencies. It does not install a Home Assistant or music server. A boot-setting change causes one automatic restart; provisioning then completes and disables the first-boot service. Follow progress locally with:

```sh
journalctl -fu pimus-firstboot
```

Wi-Fi credentials are deliberately not stored in this repository. For Wi-Fi-only first boot, extend the rpi-image-gen config with its IWD network layer variables or provision over Ethernet once.
