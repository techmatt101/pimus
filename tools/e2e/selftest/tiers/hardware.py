"""The devices themselves: the HiFiBerry and its ceiling, the microphone
array and its control path, the deck, the switchable USB ports, and whether
the controller has been struggling with any of them."""

from __future__ import annotations

from ..session import Session


TIER = "hardware"

CONTROLLER = "smartamp-controller"
CONTROLLER_TROUBLE = (
    "Unable to update ReSpeaker LEDs",
    "Unable to read the ReSpeaker microphone array",
    "Stream Deck unavailable",
    "usb power on failed",
)


def run(session: Session) -> None:
    config = session.config
    runtime = session.runtime

    if config.ceiling is not None:
        cards = runtime.alsa_playback_cards()
        session.check(TIER, "HiFiBerry playback card is present", config.ceiling.card in cards)
        level = runtime.amixer_percent(config.ceiling.card, config.ceiling.control)
        session.check(TIER, "HiFiBerry ceiling control reads", level is not None,
                      f"{config.ceiling.control} reads {level}%")

    if config.respeaker is not None:
        array = config.respeaker
        present = runtime.usb_present(array.usb_id)
        session.check(TIER, f"{array.label} is on the USB bus", present, array.usb_id)
        if present and array.host_control:
            _host_control(session)
        if config.voice.enabled:
            sources = runtime.source_names()
            session.check(TIER, "the array's capture node is published",
                          config.voice.input_name in sources, config.voice.input_name)
            if config.voice.capture_name:
                session.check(TIER, "the mono voice capture source is published",
                              config.voice.capture_name in sources, config.voice.capture_name)
            wanted = config.voice.capture_name or config.voice.input_name
            default = runtime.pactl("get-default-source")
            session.check(TIER, "the assistant's capture is the default source",
                          default == wanted, f"default source is {default!r}")

    if config.streamdeck is not None:
        deck = config.streamdeck
        session.check(TIER, f"{deck.label} is on the USB bus",
                      runtime.usb_present(deck.usb_id), deck.usb_id)

    for port in config.usb_ports:
        session.check(TIER, f"USB port control {port} is writable by the service account",
                      runtime.user_can_write(port))

    if config.controller:
        recent = runtime.journal(CONTROLLER, "-10min")
        trouble = [line for line in recent.splitlines() if any(t in line for t in CONTROLLER_TROUBLE)]
        session.check(TIER, "the controller reports no device trouble",
                      not trouble, trouble[-1] if trouble else "")


def _host_control(session: Session) -> None:
    runtime = session.runtime
    version = runtime.xvf_host("VERSION")
    session.check(TIER, "xvf_host reaches the array", version is not None,
                  f"VERSION {version}" if version else "no answer; is xvf_host installed?")
    if version is None:
        return
    for command in ("AEC_AECCONVERGED", "AUDIO_MGR_SYS_DELAY", "AUDIO_MGR_REF_GAIN"):
        answer = runtime.xvf_host(command)
        session.check(TIER, f"{command} reads", answer is not None, str(answer))
