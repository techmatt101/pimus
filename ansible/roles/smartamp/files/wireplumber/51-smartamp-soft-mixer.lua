-- Keep PipeWire's hands off the HiFiBerry's hardware mixer (WirePlumber 0.4,
-- Bookworm; 0.5+ ignores main.lua.d and reads the .conf deployed beside this
-- file instead). See 51-smartamp-soft-mixer.conf for the full story: without
-- soft-mixer, pinning the output sink at 100% pushes the DAC's `Digital`
-- control back to 0 dB and defeats the hifiberry_output_volume_percent
-- ceiling. api.alsa.soft-mixer is a property of the ALSA card, not of its
-- output node, so the rule matches the platform card; the XVF3800's USB card
-- (the AEC reference path) keeps its stock volume handling.
table.insert(alsa_monitor.rules, {
  matches = {
    {
      { "device.name", "matches", "alsa_card.platform-*" },
    },
  },
  apply_properties = {
    ["api.alsa.soft-mixer"] = true,
  },
})
