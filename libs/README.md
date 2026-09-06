# Libraries

Code more than one app needs, owned by none of them. A library holds
primitives, never policy: it is imported by the apps in [`apps/`](../apps/README.md)
and imports nothing back.

## `audio-common`

`audio-common/src/smartamp_audio/` contains shared graph queries, `pactl`, process
and event-monitor helpers, the JSON control server, status publication and
volume arithmetic. Both Python apps use these primitives; neither imports the
other app's policy or daemon. Ansible installs an exact package tree and removes
obsolete modules during an upgrade.
