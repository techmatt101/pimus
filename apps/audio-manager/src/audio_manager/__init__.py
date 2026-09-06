"""Shared audio environment: output, playback buses, local routes, echo reference.

The manager owns graph policy, music/voice gains, ducking and idle teardown.
Input clients supply audio to its named buses. The controller requests policy
changes through control/commands.py; modules.py owns the manager's loopbacks.

Small graph, process, socket, volume and status primitives live in the separate
smartamp_audio package shared with other audio apps. Device-specific mixer and
capture helpers stay in system/; echo_reference.py owns the far-end reference
a microphone array with its own echo canceller is sent. What the assistant
records is PipeWire's own configuration, deployed by Ansible, not this daemon's.
"""
