"""The command-line boundary: every external binary this daemon drives.

Nothing here decides policy. `process` runs the children, `pactl` is the
PipeWire surface, `usb_gadget` the gadget card's ALSA mixer, `parec` a capture
streaming samples to its stdout, and `monitors` the long-running children whose
output lines wake the reconcile loop. Modules in here never import from the
package above them, so the rest of the daemon has exactly one seam to patch in
tests.
"""
