"""Shared audio environment: output, playback buses, the mixer, echo reference.

The manager owns graph policy, music/voice gains, ducking and idle teardown,
and holds every music input's trim and toggle as a mixer would: a stream on
the music bus belongs to the source its `smartamp.source` property names, and
sources.py holds it at that source's level. How an input reaches the bus is
not its concern - the inputs app and the players' own units do that. The
controller requests policy changes through control/commands.py; modules.py
owns the manager's loopbacks.

Small graph, process, socket, volume and status primitives live in the separate
smartamp_audio package shared with other audio apps. Device-specific mixer and
capture helpers stay in system/; echo_reference.py owns the far-end reference
a microphone array with its own echo canceller is sent. What the assistant
records is PipeWire's own configuration, deployed by Ansible, not this daemon's.
"""
