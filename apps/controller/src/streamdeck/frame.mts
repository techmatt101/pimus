export interface FrameRegion {
    x: number
    y: number
    width: number
    height: number
}

// JPEG encodes in blocks, so an unaligned box would re-encode a partial block
// and leave a seam against the pixels the panel already holds.
const ALIGNMENT = 16

// Past this share of the face the region's own header and the extra copy cost
// more than re-encoding the whole thing.
const MAX_COVERAGE = 0.6

function samePixel(previous: Buffer, next: Buffer, at: number): boolean {
    return previous[at] === next[at]
        && previous[at + 1] === next[at + 1]
        && previous[at + 2] === next[at + 2]
        && previous[at + 3] === next[at + 3]
}

function alignDown(value: number): number {
    return Math.floor(value / ALIGNMENT) * ALIGNMENT
}

function alignUp(value: number, limit: number): number {
    return Math.min(limit, Math.ceil(value / ALIGNMENT) * ALIGNMENT)
}

/**
 * The aligned box enclosing every pixel that differs, or null when the two
 * frames match or the box covers so much that a full write is cheaper.
 */
export function changedRegion(
    previous: Buffer,
    next: Buffer,
    width: number,
    height: number,
): FrameRegion | null {
    let top = -1
    let bottom = -1
    let left = width
    let right = -1

    for (let row = 0; row < height; row += 1) {
        const rowStart = row * width * 4
        const rowEnd = rowStart + width * 4
        // A whole-row memcmp skips the untouched rows without reading a pixel.
        if (previous.compare(next, rowStart, rowEnd, rowStart, rowEnd) === 0) continue

        let first = 0
        while (first < width && samePixel(previous, next, rowStart + first * 4)) first += 1
        let last = width - 1
        while (last > first && samePixel(previous, next, rowStart + last * 4)) last -= 1

        if (top < 0) top = row
        bottom = row
        if (first < left) left = first
        if (last > right) right = last
    }

    if (top < 0) return null

    const x = alignDown(left)
    const y = alignDown(top)
    const region = {
        x,
        y,
        width: alignUp(right + 1, width) - x,
        height: alignUp(bottom + 1, height) - y,
    }
    if (region.width * region.height > width * height * MAX_COVERAGE) return null
    return region
}

/** The region's pixels lifted out of a full-width frame as a tight RGBA buffer. */
export function cropRegion(frame: Buffer, width: number, region: FrameRegion): Buffer {
    const rowBytes = region.width * 4
    const cropped = Buffer.allocUnsafe(rowBytes * region.height)
    for (let row = 0; row < region.height; row += 1) {
        const from = ((region.y + row) * width + region.x) * 4
        frame.copy(cropped, row * rowBytes, from, from + rowBytes)
    }
    return cropped
}
