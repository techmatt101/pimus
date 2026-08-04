"""What the daemon sets up on the ReSpeaker's DSP so the assistant can hear.

Both paths here involve the XVF3800 and neither reaches the speakers:
`microphone` publishes its ASR capture channel as the source the assistant
records, and `aec` sends the output's monitor back to its playback endpoint as
the far-end reference that keeps that capture usable while music plays. They
stand or fall together — unplug the device and both release.

The voice assistant's own playback is not here: TTS lands on the voice null
sink in `buses.py`, which is metered by `levels.py`. Neither is anything the
LEDs do, which belongs to the Node controller.
"""
