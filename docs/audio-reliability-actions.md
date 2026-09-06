# Audio reliability: fixes and remaining actions

Review follow-up, 5 September 2026. Changes are local; nothing has been deployed
or tested on a Pi in this pass. Firmware, DSP delay/gain, amplifier limits and
loopback latency have deliberately not been retuned.

## Implemented

- [x] The WirePlumber soft-mixer rule now matches the ALSA card
  (`device.name`), which is the object `api.alsa.soft-mixer` belongs to; the
  earlier node-scoped rule was ignored, so the hardware ceiling was very likely
  not holding at all. The doctor checks every `Digital` playback channel
  against the ceiling and rejects unreadable channels or a failed mixer read.
  Confirm on each unit after re-provisioning.
- [x] Hardware initialization now fails on a failed mixer command instead of
  continuing to `alsactl store`. The manager requires successful initialization;
  Ansible restart notifications bring dependent audio services back afterward.
- [x] Mute the output before raising its software volume to unity and before
  any loopback into it or either playback bus loads, including a USB route
  whose trim is lower than 100%. A bridge stream that has not appeared keeps the
  guard held and books a retry without failing the pass, so the rest of the
  graph (voice capture, defaults, AEC reference, routes) is still reconciled
  and published. A failed unmute retains guard ownership until a retry succeeds.
- [x] Took the user mute off the sink (September 2026): the volume mute is
  now a boolean beside the music level that plays every music path at 0%, so
  voice keeps playing and the manager owns the sink's mute outright. A sink
  found muted is an abandoned guard, released once the pass settles; the
  saved `mute.json` and its state directory went with it.
- [x] Separated USB volume and mute agreement from writes to the output sink.
  A host unmute cannot release the rebuild guard; a host mute is the volume
  mute, reflected in the manager's state in the same pass.
- [x] Music-volume commands immediately update direct playback clients, not
  just the music bus and owned input routes.
- [x] Check every channel when enforcing stream gains/output unity. A loudest
  channel of 100% no longer hides a silent left channel.
- [x] Repair muted AEC bridge streams as well as the reference sink. Separate
  endpoint presence (`aec_reference.endpoints_available`) from a configured
  active stream (`available`). Neither is a cancellation measurement.
- [x] Removed fallback to the wrong microphone output while a configured mono
  remap is unavailable. Validate channel indices and gate voice startup on the
  intended capture source and playback bus.
- [x] Doctor accepts deliberately unbridged idle buses/reference paths, but
  still rejects missing endpoints or capture. Hard reconciliation failures
  remove stale readiness status; successful recovery publishes it again.
- [x] Added a small LVA capture-failure adapter. The pinned upstream calls
  `sys.exit(1)` inside its microphone thread, leaving the server alive; the
  adapter exits the process so systemd can restart it through the readiness
  gate. Normal returns and clean exits are unchanged.
- [x] Malformed command types, invalid UTF-8 and excessively nested JSON no
  longer escape the control-socket error path. Immediate wake requests can
  advance an already scheduled reconciliation.
- [x] Simplified reconciliation into output preparation, graph reconciliation,
  guard release and publication. Removed misleading explanatory comments and
  corrected the AEC/convergence guidance in the project docs.

## Local verification

- Passed `make test`: Python and controller tests, controller
  compilation/bundle checks, Python compilation, ShellCheck and Ansible syntax.
  No tests were skipped. Also passed `git diff --check`.
- Python regression tests cover gain/mute ordering, failed and delayed graph
  setup, trimmed USB connections through an active bus, abandoned-guard
  release, failed mute writes, stale readiness, direct-client volume, channel imbalance,
  microphone readiness, malformed socket input, deployment script behavior
  and idle diagnostics.
- Separate subprocess tests verify that a failed capture worker terminates the
  whole process, not just its thread. The complete upstream LVA environment
  and physical disconnect/reconnect behavior still require a Pi test.
- `make test` covers the Python suite and its strict pyright check, controller
  tests/build/bundles, shell lint and Ansible syntax. CI now also checks the recovery adapter and shell
  scripts. The escape regression test is not a complete SPA-JSON parser.

## Remaining actions, in order

### Playback and pop validation

- [ ] **P0 — Verify the hardware ceiling on each board.** Read `amixer`'s
  `Digital` value and dB level after boot, PipeWire/WirePlumber restart and
  volume changes. Confirm all channels retain the configured ceiling and the
  soft-mixer property is actually applied. Check both WirePlumber generations
  if both remain supported. A valid config file alone does not prove this.
- [ ] **P0 — Capture the transients.** Begin at a conservatively attenuated
  output. Exercise cold boot, manager restart, idle wake, aux toggles, USB
  playback start/stop, ReSpeaker reconnect and PipeWire restart. Record output
  waveforms/peak levels and the journal, including a failed-then-recovered
  rebuild. Pass only when there is no unexpected full-level burst; report
  remaining clicks separately from overload pops.
- [ ] **P0 — Check the safety-mute tradeoffs.** The guard is a mute switch,
  not a waveform ramp. Check for clicks and missing first syllables on release.
  Kill the manager mid-rebuild and confirm the next start releases the
  guard it left behind. Repeat across reboot and with an attenuated USB input
  trim.
- [ ] **P1 — Close the remaining first-stream race.** Direct clients, and
  streams recreated independently by PipeWire, can play before the manager
  observes them. Evaluate a permanent music bus independent of ducking,
  explicit startup gain/mute supported by the deployed PipeWire version, or
  retaining bridges through idle. Measure power and startup latency before
  choosing; do not claim the current guard covers these external races.
- [ ] **P1 — Replace stepped fades only after measurement.** Current fades
  block the manager between `pactl` writes and are not sample-accurate. Compare
  a native ramp/non-blocking transition implementation using aux DC-offset
  recordings and worst-case control latency. Avoid more timing flags or
  threads unless the measurements justify them.
- [ ] **P1 — Check amplifier and physical causes.** Inspect Amp100 clipping
  indication and gain-jumper position; verify the supply, speaker load and
  board-specific mute behavior. Check AAmp60 power headroom, cabling, grounding
  and mechanical coupling. Do not change GPIO mute, auto-mute or gain jumpers
  as a universal software fix. Use the [Amp100 datasheet](https://www.hifiberry.com/docs/data-sheets/datasheet-amp100/)
  and [AAmp60 datasheet](https://www.hifiberry.com/docs/data-sheets/datasheet-aamp60/).

### AEC and microphone validation

- [ ] **P0 — Record the exact baseline.** Per unit, save firmware version,
  USB/ALSA formats and channel maps, DSP output muxes, reference/mic gains,
  system delay and LVA preferences. Verify that the configured capture channel
  really is ASR on that firmware. Do not flash newer firmware or write
  `save_configuration` as part of this check. See the [Seeed device guide](https://wiki.seeedstudio.com/respeaker_xvf3800_introduction/).
- [ ] **P0 — Test reference channel coverage.** Play short, attenuated
  left-only, right-only and dual-mono signals through each relevant source.
  The XVF3800 consumes only the left reference channel, while the current
  loopback preserves stereo. Compare reference and microphone residuals;
  determine whether playback should become mono or another reference strategy
  is needed. Downmixing a reference alone does not guarantee cancellation of
  two independent stereo acoustic paths. See the [XMOS datasheet, section 3.3.3](https://www.xmos.ai/download/XVF3800-Device-Datasheet%282_0_0%29.pdf).
- [ ] **P0 — Measure causal timing inside the DSP.** Capture the reference
  and microphone diagnostic taps together using the vendor mux procedure.
  Do not align independently started PipeWire recordings. The reference must
  precede its acoustic echo; a long filter tail is not permission for a late
  reference. Read the baseline before any signed system-delay change.
- [ ] **P0 — Measure headroom and cancellation, not only convergence.** Use
  a bounded, attenuated stimulus on an explicitly selected, verified bus;
  never unbounded full-scale `/dev/urandom` into the default output. Record
  reference, microphone and ASR peaks/clipping plus residual echo during
  far-end-only and simultaneous speech/music tests. `AEC_AECCONVERGED` is
  latched and does not certify the current path. Follow the
  [XMOS tuning procedure](https://www.xmos.com/documentation/XM-014888-PC/html/modules/fwk_xvf/doc/user_guide/04_tuning_the_application.html).
- [ ] **P1 — Validate placement and wake pickup.** Keep microphone openings
  unobstructed and check orientation, distance and speaker vibration coupling.
  Establish repeated wake/miss/false-wake counts at fixed positions and music
  levels before changing ASR gain, LVA AGC or model sensitivity. Compare one
  change at a time. Historical office-amp measurements are not a pass for
  other rooms or a reason to dismiss echo leakage.
- [ ] **P1 — Exercise capture recovery.** Unplug/replug the array and restart
  PipeWire while LVA is recording. Verify process restart, fresh mono-source
  selection, working wake detection and Home Assistant reconnection. Also
  test a silent or blocked recorder: no exception means the new adapter has
  nothing to detect. Decide on an observable capture watchdog only if needed.

### Cleanup after the baseline is solid

- [ ] Add real PipeWire graph integration tests for module publication,
  adoption and independently recreated streams; tighten module identity and
  route-argument matching where those tests demonstrate stale adoption.
- [ ] Check restored null-sink and bus-bridge gain/mute plus client trim, and document a single
  owner for every gain. Avoid adding another gain layer as a workaround.
- [ ] Measure reconciliation command count and worst-case latency before
  replacing the cached `pactl` graph interface with a larger dependency.
- [ ] Keep voice-event policy in the controller. Do not add a second software
  AEC or new audio features until the P0 measurements above are repeatable.

For the capture-thread defect, see the pinned
[LVA 1.1.14 implementation](https://github.com/OHF-Voice/linux-voice-assistant/blob/v1.1.14/linux_voice_assistant/__main__.py).
For the configuration format, see the
[WirePlumber configuration reference](https://pipewire.pages.freedesktop.org/wireplumber/daemon/configuration/conf_file.html).
