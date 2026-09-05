# Audio manager structure review

Reviewed 5 September 2026. The existing package boundaries suit this daemon;
a broad rewrite would add churn without resolving its main risks. The useful
changes are in state consistency and recovery from failed I/O.

## Comparison with established designs

| Reference | Application here |
| --- | --- |
| [Mopidy architecture](https://docs.mopidy.com/latest/reference/architecture/) separates protocol frontends, core controllers, audio, and mixing. | Keep `control/` for the socket protocol, `daemon.py` for orchestration, and the existing bus, route, output, and hardware components. Mopidy's actor framework is unnecessary for this single selector loop. |
| [Architecture Patterns with Python, chapter 3](https://www.cosmicpython.com/book/chapter_03_abstractions) advocates simple abstractions that contain complexity and reduce coupling. | Keep the small configuration dataclasses, microphone strategies, and `system/` command boundary. Add one small `AppliedRoute` record to keep a stream identity and its applied toggle together, replacing parallel mutable dictionaries. |
| [Refactoring: Replace Derived Variable with Query](https://refactoring.com/catalog/replaceDerivedVariableWithQuery.html) removes independently maintained derived values. | Use the existing state event itself for change detection. A separate, manually selected signature omitted fields and could drift from the protocol. Retain the last event as a historical snapshot. |

These are design comparisons, not claims that this daemon implements those
projects' complete architectures. No new framework or dependency is needed.

## Changes and their observable effects

- **Route toggle and gain:** background-target inputs previously skipped the
  off/on logic and applied their trim even when an always-connected route was
  switched off. Both targets now use the same transition logic. Background
  routes still carry only their own trim; direct routes carry music gain too.
- **Applied route state:** stream identity and the successful toggle are
  recorded together after the writes complete. Recreated streams start with
  unknown applied state. Tests establish routes through their behavior instead
  of manually seeding two internal dictionaries.
- **Client updates:** all fields in the state event participate in change
  detection, including voice volume, source toggles, and ducking released by a
  disconnect. Unchanged events are not broadcast repeatedly.
- **Interrupted fades:** clear the cached gain before starting a write sequence.
  If part of a fade fails, reversing the request must restore the actual gain
  instead of trusting the value cached before the failed fade.
- **USB recovery:** observing an absent gadget discards its old volume
  agreement. When it reappears, the amp seeds it again rather than treating a
  reset mixer value as a new host request.
- **Lifecycle:** startup and the event loop share a `finally` cleanup path.
  Shutdown withdraws readiness, releases resources and modules, and suppresses
  lease side effects that could restart metering while closing. Stopping during
  the PipeWire readiness wait does not subsequently start services.

Configuration, socket messages, status fields, gain ownership, and package
layout remain compatible.

## Verification and limits

The original 82 Python tests passed before editing. Added state-transition
regressions reproduced the route, broadcast, failed-fade, USB, and cleanup
defects before the fixes. The resulting suite has 91 tests, including route
recreation, failed-write recovery, multiple real socket connections, and
cleanup after a helper fails.

`make test` checks the Python tests and compilation, controller tests/build and
bundles, ShellCheck, and Ansible syntax. Physical PipeWire timing, playback pops,
AEC performance, and unobserved hardware resets cannot be certified by these
tests. Existing measurement work remains in
[audio reliability actions](audio-reliability-actions.md); in particular,
blocking fades and the first-stream race still need hardware evidence before
choosing a larger redesign.
