from __future__ import annotations
import sys
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock
sys.path.insert(0, str(Path(__file__).parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).parents[3] / "libs/audio-common/src"))
from usb_audio import gadget as usb_gadget
from smartamp_audio import process

def completed(*args: str, returncode: int = 0, stdout: str = "") -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(args, returncode, stdout=stdout, stderr="")


class UsbGadgetTests(unittest.TestCase):
    def test_usb_host_detection_reads_the_udc_state_file(self) -> None:
        with tempfile.TemporaryDirectory() as base:
            root = Path(base)
            self.assertFalse(usb_gadget.host_attached(root))

            udc = root / "1000480000.usb"
            udc.mkdir()
            (udc / "state").write_text("not attached\n", encoding="utf-8")
            self.assertFalse(usb_gadget.host_attached(root))

            (udc / "state").write_text("configured\n", encoding="utf-8")
            self.assertTrue(usb_gadget.host_attached(root))

        self.assertFalse(usb_gadget.host_attached(root / "missing"))

    def test_usb_streaming_detection_reads_the_gadget_rate_control(self) -> None:
        listing = (
            "numid=4,iface=PCM,name='Capture Rate'\n"
            "  ; type=INTEGER,access=r--v----,values=1,min=48000,max=48000,step=0\n"
            "  : values={rate}\n"
        )
        cases = [
            (completed("amixer", stdout=listing.format(rate=48000)), True),
            (completed("amixer", stdout=listing.format(rate=0)), False),
            (completed("amixer", returncode=1), False),
            (completed("amixer", stdout="garbage"), False),
        ]
        for result, expected in cases:
            with mock.patch.object(process, "run", return_value=result):
                self.assertEqual(usb_gadget.streaming(), expected)

