-- Keep PipeWire's hands off the HiFiBerry's hardware mixer (WirePlumber 0.4,
-- Bookworm; 0.5+ ignores main.lua.d and reads the .conf deployed beside this
-- file instead). See 51-smartamp-soft-mixer.conf for the full story: without
-- soft-mixer, pinning the output sink at 100% pushes the DAC's `Digital`
-- control back to 0 dB and defeats the hifiberry_output_volume_percent
-- ceiling. Scoped to platform outputs so the XVF3800's USB playback endpoint
-- (the AEC reference path) keeps its stock volume handling.
table.insert(alsa_monitor.rules, {
  matches = {
    {
      { "node.name", "matches", "alsa_output.platform-*" },
    },
  },
  apply_properties = {
    ["api.alsa.soft-mixer"] = true,
  },
})
