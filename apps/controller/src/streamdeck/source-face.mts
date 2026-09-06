import type {IconName} from './icon-set.mjs'

/** How a key draws one source the audio services publish. */
export interface SourceFace {
    /** Defaults to the source's name, upper-cased. */
    label?: string
    icon: IconName
    color: string
}

export type SourceFaces = Partial<Record<string, SourceFace>>

const PLAIN_FACE: SourceFace = {icon: 'note', color: '#37474f'}

export function faceOf(faces: SourceFaces, name: string | undefined): SourceFace {
    return (name !== undefined && faces[name]) || PLAIN_FACE
}

export function labelOf(faces: SourceFaces, name: string): string {
    return faces[name]?.label ?? name.toUpperCase()
}
