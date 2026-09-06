"""Shared audio environment: output, playback buses, local routes and microphone.

The manager owns graph policy, music/voice gains, ducking and idle teardown.
Input clients supply audio to its named buses. The controller requests policy
changes through control/commands.py; modules.py owns the manager's loopbacks.

Small graph, process, socket, volume and status primitives live in the separate
smartamp_audio package shared with other audio apps. Device-specific mixer and
capture helpers stay in system/; microphone/ owns capture and echo reference.
"""
