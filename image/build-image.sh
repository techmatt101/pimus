#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
IMAGE_GEN_VERSION=v2.6.0
BUILDER_DIR=${RPI_IMAGE_GEN_DIR:-"$PROJECT_ROOT/artifacts/rpi-image-gen"}

if [[ $(uname -s) != Linux ]]; then
    echo 'rpi-image-gen requires a Linux build host. Use Debian Bookworm/Trixie; native arm64 is the supported path.' >&2
    exit 1
fi

if [[ ! -x "$BUILDER_DIR/rpi-image-gen" ]]; then
    mkdir -p "$(dirname "$BUILDER_DIR")"
    git clone --depth 1 --branch "$IMAGE_GEN_VERSION" \
        https://github.com/raspberrypi/rpi-image-gen.git "$BUILDER_DIR"
fi

if [[ ${1:-} == --install-deps ]]; then
    cd "$BUILDER_DIR"
    sudo ./install_deps.sh
    exit 0
fi

SSH_KEY_FILE=${SMARTAMP_SSH_PUBKEY_FILE:-}
if [[ -z "$SSH_KEY_FILE" || ! -f "$SSH_KEY_FILE" ]]; then
    echo 'Set SMARTAMP_SSH_PUBKEY_FILE to a public-key file before building.' >&2
    echo 'Example: SMARTAMP_SSH_PUBKEY_FILE=/path/to/id_ed25519.pub make image' >&2
    exit 2
fi

if [[ $(uname -m) != aarch64 ]]; then
    echo 'Warning: Raspberry Pi supports native Debian arm64 builds; this host may require QEMU/binfmt.' >&2
fi

BUILD_SOURCE=$(mktemp -d)
cleanup() {
    if [[ -n ${BUILD_SOURCE:-} && -d "$BUILD_SOURCE" ]]; then
        rm -rf -- "$BUILD_SOURCE"
    fi
}
trap cleanup EXIT

mkdir -p \
    "$BUILD_SOURCE/config" \
    "$BUILD_SOURCE/layer" \
    "$BUILD_SOURCE/rootfs-overlay/opt/pimus" \
    "$BUILD_SOURCE/rootfs-overlay/etc/systemd/system/multi-user.target.wants"

cp "$PROJECT_ROOT/image/config/smartamp.yaml" "$BUILD_SOURCE/config/"
cp "$PROJECT_ROOT/image/layer/smartamp-firstboot.yaml" "$BUILD_SOURCE/layer/"
rsync -a \
    --exclude .git \
    --exclude .ansible \
    --exclude artifacts \
    --exclude node_modules \
    --exclude __pycache__ \
    "$PROJECT_ROOT/" "$BUILD_SOURCE/rootfs-overlay/opt/pimus/"
install -m 0644 "$PROJECT_ROOT/image/pimus-firstboot.service" \
    "$BUILD_SOURCE/rootfs-overlay/etc/systemd/system/pimus-firstboot.service"
ln -s ../pimus-firstboot.service \
    "$BUILD_SOURCE/rootfs-overlay/etc/systemd/system/multi-user.target.wants/pimus-firstboot.service"

SSH_PUBLIC_KEY=$(<"$SSH_KEY_FILE")
cd "$BUILDER_DIR"
./rpi-image-gen build \
    -S "$BUILD_SOURCE" \
    -c "$BUILD_SOURCE/config/smartamp.yaml" \
    -- "IGconf_ssh_pubkey_user1=$SSH_PUBLIC_KEY"

mkdir -p "$PROJECT_ROOT/artifacts/images"
IMAGE_PATH=$(find "$BUILDER_DIR/work" -type f \
    \( -name 'pimus-office-amp.img' -o -name 'pimus-office-amp.img.zst' \) \
    -print | sort | tail -n 1)
if [[ -z "$IMAGE_PATH" ]]; then
    echo 'Build completed but the pimus-office-amp image was not found under the builder work directory.' >&2
    exit 3
fi
cp "$IMAGE_PATH" "$PROJECT_ROOT/artifacts/images/"
echo "Image: $PROJECT_ROOT/artifacts/images/$(basename "$IMAGE_PATH")"
