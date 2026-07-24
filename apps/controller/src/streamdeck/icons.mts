import {Image} from '@napi-rs/canvas'

import {ICON_MARKUP, ICON_VIEWBOX, type IconName} from './icon-set.mjs'

// Every name, size, and tint comes from a compiled-in constant, so the cache is
// small and fixed.
const cache = new Map<string, Image>()

export function iconImage(name: IconName, size: number, color: string): Image {
    // Rasterize at whole pixels: an animated key varies its icon size by a
    // fraction every frame, and caching each of those would grow without bound.
    const raster = Math.max(1, Math.round(size))
    const key = `${name}|${raster}|${color}`
    const cached = cache.get(key)
    if (cached) return cached

    // An SVG rasterizes at the size declared on its root element, not the size
    // it is drawn to, so the wrapper is built at the target size. The artwork
    // strokes in `currentColor`, which resolves from the wrapper's `color`.
    const image = new Image()
    image.src = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${raster}" height="${raster}"` +
        ` viewBox="0 0 ${ICON_VIEWBOX} ${ICON_VIEWBOX}" fill="none" color="${color}">${ICON_MARKUP[name]}</svg>`,
    )
    cache.set(key, image)
    return image
}

/** Conditions Home Assistant adds later fall through to plain cloud. */
export function conditionIcon(condition: string): { icon: IconName; color: string } {
    if (condition === 'clear-night') return {icon: 'moon', color: '#b0bec5'}
    if (condition.includes('sunny')) {
        return condition.startsWith('partly')
            ? {icon: 'sunCloud', color: '#ffd54f'}
            : {icon: 'sun', color: '#ffd54f'}
    }
    if (condition.startsWith('partlycloudy')) return {icon: 'sunCloud', color: '#ffd54f'}
    if (condition.includes('lightning')) return {icon: 'lightning', color: '#ffd54f'}
    if (condition.includes('hail')) return {icon: 'hail', color: '#e1f5fe'}
    if (condition.includes('snow')) return {icon: 'snow', color: '#e1f5fe'}
    if (condition.includes('rain') || condition.includes('pouring')) return {icon: 'rain', color: '#4fc3f7'}
    if (condition.includes('fog')) return {icon: 'fog', color: '#b0bec5'}
    if (condition.includes('wind')) return {icon: 'wind', color: '#b0bec5'}
    if (condition === 'exceptional') return {icon: 'alert', color: '#ff8a65'}
    return {icon: 'cloud', color: '#b0bec5'}
}

export type {IconName}
