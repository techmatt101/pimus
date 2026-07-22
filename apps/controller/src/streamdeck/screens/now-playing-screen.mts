// The strip's resting face: what is playing, across the full width. This is
// what the touch strip shows whenever no dial is being turned and no
// notification is up.
//
// The reading comes from the Music Assistant player entity rather than from the
// controller's own `media` flag, because that flag is only "is something
// playing" — the title, the artist, and the position exist solely in Home
// Assistant. The screen watches that one entity while mounted, exactly as a tile
// does, so the strip keeps working on pages where no key happens to watch the
// player.

import { requireEntity } from '../../actions/catalog.mjs'
import { mediaElapsedSeconds, numericAttribute } from '../../home-assistant/entity.mjs'
import type { TileServices } from '../bindings.mjs'
import { fittingSize, REGULAR, type Surface } from '../surface.mjs'
import {
  drawStripBar,
  drawStripLine,
  overflows,
  SCROLL_FRAME_MILLISECONDS,
  STRIP_MARGIN,
  STRIP_WIDTH,
  type Screen,
  type ScreenContext,
  type ScreenHost,
} from './screen.mjs'
import type { HomeAssistantEntity, HomeAssistantService } from '../../types.mjs'

/** Title sizes tried in turn, so a short title is drawn large. */
const TITLE_SIZES = [56, 46, 36]
const SECONDARY_SIZE = 24
/** The width a title has to fit before it starts scrolling. */
const TITLE_AVAILABLE = STRIP_WIDTH - STRIP_MARGIN * 2
/** How often the position bar creeps forward while a track plays. */
const POSITION_FRAME_MILLISECONDS = 1000

/** The resting strip is washed rather than flat, like the key faces. */
const BACKDROP = ['#16222b', '#0b1116'] as const

const PLAYING_TITLE = '#ffffff'
const PAUSED_TITLE = '#78909c'
const SECONDARY = '#80deea'
const IDLE = '#546e7a'

export interface NowPlayingOptions {
  /** The `media_player.` entity whose track the strip reports. */
  player: string
}

/**
 * The two lines the strip shows for a player: what is playing, and who by.
 * Derived separately from the drawing so the wording is testable and so the
 * three cases the strip must tell apart — playing something, playing nothing,
 * and not knowing — stay explicit.
 */
export function nowPlayingLines(
  player: HomeAssistantEntity | undefined,
  connected: boolean,
): { title: string; secondary: string; idle: boolean } {
  // An unreachable Home Assistant must not read as a quiet room, the same rule
  // the Home Assistant keys follow.
  if (!connected || !player) return { title: 'NO MEDIA INFO', secondary: '', idle: true }

  const title = text(player.attributes.media_title)
  if (!title) return { title: 'NOTHING PLAYING', secondary: '', idle: true }

  const artist = text(player.attributes.media_artist) || text(player.attributes.media_album_artist)
  const album = text(player.attributes.media_album_name)
  const by = [artist, album].filter(Boolean).join(' - ')
  const paused = player.state !== 'playing'
  return {
    title,
    secondary: paused ? ['PAUSED', by].filter(Boolean).join(' - ') : by,
    idle: false,
  }
}

export class NowPlayingScreen implements Screen {
  private readonly ha: HomeAssistantService
  private readonly player: string
  private unwatch: (() => void) | null = null

  constructor(services: TileServices, { player }: NowPlayingOptions) {
    this.ha = services.ha
    this.player = requireEntity(player, 'now playing screen')
  }

  mount(host: ScreenHost): void {
    this.unwatch = this.ha.watch([this.player], () => host.invalidate())
  }

  unmount(): void {
    this.unwatch?.()
    this.unwatch = null
  }

  /**
   * Frames for a title too long to sit still, and a slow tick while a track is
   * playing so its position bar creeps forward. Music Assistant reports a
   * position once and then says nothing, so without the tick the bar would only
   * move when something unrelated repainted the deck.
   */
  animationMilliseconds(): number | undefined {
    const player = this.ha.entity(this.player)
    const { title, idle } = nowPlayingLines(player, this.ha.connected)
    if (idle) return undefined
    if (overflows(title, fittingSize(title, TITLE_SIZES, TITLE_AVAILABLE))) return SCROLL_FRAME_MILLISECONDS
    const playing = player?.state === 'playing'
    return playing && hasPosition(player) ? POSITION_FRAME_MILLISECONDS : undefined
  }

  draw(surface: Surface, { now }: ScreenContext): void {
    const player = this.ha.entity(this.player)
    const { title, secondary, idle } = nowPlayingLines(player, this.ha.connected)
    surface.fill(surface.verticalGradient(BACKDROP[0], BACKDROP[1]))

    if (idle) {
      drawStripLine(surface, title, { centerY: 50, size: 34, color: IDLE, now })
      return
    }

    const playing = player?.state === 'playing'
    drawStripLine(surface, title, {
      centerY: secondary ? 36 : 46,
      size: fittingSize(title, TITLE_SIZES, TITLE_AVAILABLE),
      color: playing ? PLAYING_TITLE : PAUSED_TITLE,
      now,
    })
    if (secondary) {
      // Lighter than the title, so the strip reads as one line with a credit
      // under it rather than as two competing lines.
      drawStripLine(surface, secondary, {
        centerY: 74,
        size: SECONDARY_SIZE,
        color: SECONDARY,
        weight: REGULAR,
        now,
      })
    }

    // A position bar only where the player reports one; Music Assistant does for
    // a track and does not for a live stream.
    const duration = numericAttribute(player, 'media_duration')
    const elapsed = mediaElapsedSeconds(player, now)
    if (hasPosition(player) && duration && elapsed !== undefined) {
      drawStripBar(surface, elapsed / duration, { color: playing ? '#26c6da' : '#37474f' })
    }
  }
}

/** Whether the player reports both a length and a position, so a bar means something. */
function hasPosition(player: HomeAssistantEntity | undefined): boolean {
  const duration = numericAttribute(player, 'media_duration')
  return duration !== undefined && duration > 0 && numericAttribute(player, 'media_position') !== undefined
}

/** A trimmed string attribute, or '' for anything Home Assistant left unset. */
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
