"""How the Node controller drives this daemon: one Unix socket, two halves.

`server` is the transport and knows nothing about audio — it accepts clients,
frames newline-delimited JSON, and drops one that floods. `commands` is the
vocabulary, and holds the ducking, metering and standby requests against the
connection that asked for them, which is what makes the socket itself the
liveness signal: a controller that dies has its leases released by the kernel
closing its end.

The status file is not here. It is written by `status` for the doctor script
and the voice assistant's start-up wait, not read by the controller.
"""
