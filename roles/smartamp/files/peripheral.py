#!/usr/bin/env python3
"""Drive XVF3800 LEDs from Linux Voice Assistant's peripheral API."""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import struct
from pathlib import Path
from typing import Any

import usb.core
import usb.util
import websockets
import yaml


LOG = logging.getLogger("smartamp-peripheral")
EFFECTS = {"off": 0, "breath": 1, "rainbow": 2, "single": 3, "doa": 4, "ring": 5}
COMMANDS = {
    "LED_EFFECT": (20, 12, "uint8"),
    "LED_BRIGHTNESS": (20, 13, "uint8"),
    "LED_SPEED": (20, 15, "uint8"),
    "LED_COLOR": (20, 16, "uint32"),
    "LED_DOA_COLOR": (20, 17, "uint32"),
}
CRITICAL_STATES = {"muted", "disconnected", "pipeline_error", "timer_ringing"}


def rgb(value: str) -> int:
    return int(value.lstrip("#"), 16) & 0xFFFFFF


class XVF3800:
    def __init__(self, vendor_id: int, product_id: int) -> None:
        self.vendor_id = vendor_id
        self.product_id = product_id
        self.device: Any = None

    def connect(self) -> None:
        self.device = usb.core.find(idVendor=self.vendor_id, idProduct=self.product_id)
        if self.device is None:
            raise RuntimeError(f"ReSpeaker {self.vendor_id:04x}:{self.product_id:04x} not found")

    def write(self, name: str, values: list[int]) -> None:
        if self.device is None:
            self.connect()
        resid, command, data_type = COMMANDS[name]
        if data_type == "uint8":
            payload = bytes(value & 0xFF for value in values)
        else:
            payload = b"".join(struct.pack("<I", value) for value in values)
        try:
            self.device.ctrl_transfer(
                usb.util.CTRL_OUT | usb.util.CTRL_TYPE_VENDOR | usb.util.CTRL_RECIPIENT_DEVICE,
                0,
                command,
                resid,
                payload,
                timeout=8000,
            )
        except usb.core.USBError:
            self.device = None
            raise

    def apply(self, spec: dict[str, Any], brightness: int, speed: int) -> None:
        effect = str(spec.get("effect", "off")).lower()
        if effect not in EFFECTS:
            effect = "single"
        self.write("LED_BRIGHTNESS", [max(0, min(255, brightness))])
        self.write("LED_SPEED", [max(0, min(255, speed))])
        self.write("LED_COLOR", [rgb(str(spec.get("color", "#000000")))])
        if effect == "doa":
            self.write(
                "LED_DOA_COLOR",
                [rgb(str(spec.get("color", "#000000"))), rgb(str(spec.get("accent", "#00bcd4")))],
            )
        self.write("LED_EFFECT", [EFFECTS[effect]])


class Peripheral:
    def __init__(self, config: dict[str, Any]) -> None:
        self.config = config
        device = config["respeaker"]
        self.ring = XVF3800(int(device["vendor_id"]), int(device["product_id"]))
        self.state_file = Path(config["state_file"])
        self.assist_state = "disconnected"
        self.muted = False
        self.last_signature = ""

    def read_local(self) -> dict[str, Any]:
        try:
            return json.loads(self.state_file.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            return {"mode": "voice", "color": "#00bcd4"}

    def write_local(self, state: dict[str, Any]) -> None:
        temporary = self.state_file.with_suffix(".tmp")
        temporary.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, self.state_file)

    def desired(self) -> dict[str, Any]:
        local = self.read_local()
        current = "muted" if self.muted else self.assist_state
        if current in CRITICAL_STATES or local.get("mode", "voice") == "voice":
            spec = dict(self.config["states"].get(current, self.config["states"]["idle"]))
            if "brightness" in local:
                spec["brightness"] = local["brightness"]
            return spec
        mode = str(local.get("mode", "off"))
        return {
            "effect": mode,
            "color": local.get("color", "#00bcd4"),
            "accent": "#ffffff",
            "brightness": local.get("brightness", self.config["respeaker"].get("brightness", 64)),
        }

    async def render(self, force: bool = False) -> None:
        spec = self.desired()
        signature = json.dumps(spec, sort_keys=True)
        if not force and signature == self.last_signature:
            return
        try:
            await asyncio.to_thread(
                self.ring.apply,
                spec,
                int(spec.get("brightness", self.config["respeaker"].get("brightness", 64))),
                int(self.config["respeaker"].get("speed", 2)),
            )
            self.last_signature = signature
        except Exception as error:  # Device can be hot-plugged.
            LOG.warning("Unable to update ReSpeaker LEDs: %s", error)

    async def local_watch(self) -> None:
        while True:
            await self.render()
            await asyncio.sleep(0.5)

    async def register(self, websocket: Any) -> None:
        device = self.config["respeaker"]
        await websocket.send(
            json.dumps(
                {
                    "command": "register_light",
                    "data": {
                        "name": device["light_name"],
                        "object_id": device["light_object_id"],
                        "effects": ["Voice Assistant", "Off", "Breath", "Rainbow", "Single", "DOA"],
                        "supports_rgb": True,
                        "supports_brightness": True,
                    },
                }
            )
        )

    async def event(self, message: dict[str, Any]) -> None:
        event = message.get("event")
        data = message.get("data") or {}
        if event == "snapshot":
            self.muted = bool(data.get("muted", False))
            self.assist_state = "idle" if data.get("ha_connected") else "disconnected"
        elif event == "muted":
            self.muted = bool(data.get("muted", False))
            if not self.muted:
                self.assist_state = "idle"
        elif event == "zeroconf" and data.get("status") == "connected":
            self.assist_state = "idle"
        elif event == "light_command" and data.get("object_id") == self.config["respeaker"]["light_object_id"]:
            effect = str(data.get("effect") or "Single")
            mode = "voice" if effect == "Voice Assistant" else effect.lower()
            if not data.get("state", True):
                mode = "off"
            red = int(float(data.get("red", 0.0)) * 255)
            green = int(float(data.get("green", 0.74)) * 255)
            blue = int(float(data.get("blue", 0.83)) * 255)
            brightness = int(float(data.get("brightness", 1.0)) * 255)
            self.write_local(
                {"mode": mode, "color": f"#{red:02x}{green:02x}{blue:02x}", "brightness": brightness}
            )
        elif event in self.config["states"]:
            self.assist_state = str(event)
        elif event in {"tts_finished", "idle"}:
            self.assist_state = "idle"
        elif event == "timer_updated":
            self.assist_state = "timer_ticking"
        await self.render(force=True)

    async def websocket_loop(self) -> None:
        while True:
            try:
                async with websockets.connect(self.config["lva_uri"]) as websocket:
                    LOG.info("Connected to Linux Voice Assistant peripheral API")
                    await self.register(websocket)
                    async for raw in websocket:
                        await self.event(json.loads(raw))
            except Exception as error:
                self.assist_state = "disconnected"
                await self.render(force=True)
                LOG.warning("Peripheral API disconnected: %s", error)
                await asyncio.sleep(3)

    async def execute(self) -> None:
        await asyncio.gather(self.local_watch(), self.websocket_loop())


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    config = yaml.safe_load(args.config.read_text(encoding="utf-8"))
    asyncio.run(Peripheral(config).execute())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
