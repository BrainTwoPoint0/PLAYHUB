// Pitch-boundary calibration marks: the operator ground truth.
//
// A venue admin marks named reference points on a still of the scene's RAW
// panorama (grassroots pitch paint is not a reliable calibration target — the
// operator's eye is). Marks are immutable once saved; recalibration inserts a
// new playhub_pitch_calibrations row.
//
// THE pitch-frame orientation convention (must match the migration comment and
// every consumer): origin = corner_nw, +x runs along the pitch LENGTH toward
// corner_ne, +y toward corner_sw. midline_n/midline_s sit at x = length/2.
// pitch_focus 'left_half' = x < length/2, 'right_half' = x >= length/2.

export const CORNER_MARK_NAMES = [
  'corner_nw',
  'corner_ne',
  'corner_se',
  'corner_sw',
] as const

export const MIDLINE_MARK_NAMES = ['midline_n', 'midline_s'] as const

export const MARK_NAMES = [...CORNER_MARK_NAMES, ...MIDLINE_MARK_NAMES] as const

export type MarkName = (typeof MARK_NAMES)[number]

export interface PitchMark {
  name: MarkName
  /** Pixel position in the raw panorama frame (x right, y down). */
  uv: [number, number]
}

export interface PitchDims {
  lengthM: number
  widthM: number
}

export const PITCH_LENGTH_BOUNDS: [number, number] = [20, 130]
export const PITCH_WIDTH_BOUNDS: [number, number] = [15, 100]

/** World position (metres, pitch frame) of a named mark. */
export function markWorldPoint(
  name: MarkName,
  dims: PitchDims
): [number, number] {
  const { lengthM: L, widthM: W } = dims
  switch (name) {
    case 'corner_nw':
      return [0, 0]
    case 'corner_ne':
      return [L, 0]
    case 'corner_se':
      return [L, W]
    case 'corner_sw':
      return [0, W]
    case 'midline_n':
      return [L / 2, 0]
    case 'midline_s':
      return [L / 2, W]
  }
}

export type PitchFocus = 'full' | 'left_half' | 'right_half'

export const PITCH_FOCUS_VALUES: PitchFocus[] = [
  'full',
  'left_half',
  'right_half',
]

/** Whether a pitch-frame point falls in the focused half. */
export function inFocusHalf(
  x: number,
  focus: PitchFocus,
  dims: PitchDims
): boolean {
  if (focus === 'full') return true
  return focus === 'left_half' ? x < dims.lengthM / 2 : x >= dims.lengthM / 2
}

export interface MarksValidationError {
  code:
    | 'not_array'
    | 'bad_mark'
    | 'unknown_name'
    | 'duplicate_name'
    | 'missing_corners'
    | 'incomplete_midline'
    | 'out_of_frame'
  detail: string
}

/**
 * Validate an untrusted marks payload. Requires all 4 corners exactly once;
 * midline is optional but must be BOTH endpoints or neither. uv must be finite
 * and inside the frame.
 */
export function validateMarks(
  input: unknown,
  frameWidth: number,
  frameHeight: number
): { marks: PitchMark[] } | { error: MarksValidationError } {
  if (!Array.isArray(input)) {
    return { error: { code: 'not_array', detail: 'marks must be an array' } }
  }
  const seen = new Set<string>()
  const marks: PitchMark[] = []
  for (const raw of input) {
    if (
      typeof raw !== 'object' ||
      raw === null ||
      typeof (raw as { name?: unknown }).name !== 'string' ||
      !Array.isArray((raw as { uv?: unknown }).uv)
    ) {
      return {
        error: { code: 'bad_mark', detail: 'each mark needs name and uv' },
      }
    }
    const name = (raw as { name: string }).name
    const uv = (raw as { uv: unknown[] }).uv
    if (!(MARK_NAMES as readonly string[]).includes(name)) {
      return { error: { code: 'unknown_name', detail: `unknown mark ${name}` } }
    }
    if (seen.has(name)) {
      return {
        error: { code: 'duplicate_name', detail: `duplicate mark ${name}` },
      }
    }
    seen.add(name)
    if (
      uv.length !== 2 ||
      typeof uv[0] !== 'number' ||
      typeof uv[1] !== 'number' ||
      !Number.isFinite(uv[0]) ||
      !Number.isFinite(uv[1])
    ) {
      return {
        error: { code: 'bad_mark', detail: `mark ${name} uv must be [x, y]` },
      }
    }
    const [x, y] = uv as [number, number]
    if (x < 0 || y < 0 || x > frameWidth || y > frameHeight) {
      return {
        error: {
          code: 'out_of_frame',
          detail: `mark ${name} at (${x}, ${y}) is outside the ${frameWidth}x${frameHeight} frame`,
        },
      }
    }
    marks.push({ name: name as MarkName, uv: [x, y] })
  }
  for (const corner of CORNER_MARK_NAMES) {
    if (!seen.has(corner)) {
      return {
        error: { code: 'missing_corners', detail: `missing ${corner}` },
      }
    }
  }
  const midlineCount = MIDLINE_MARK_NAMES.filter((n) => seen.has(n)).length
  if (midlineCount === 1) {
    return {
      error: {
        code: 'incomplete_midline',
        detail: 'midline needs both midline_n and midline_s (or neither)',
      },
    }
  }
  return { marks }
}

/** True when the calibration carries both midline marks (half-focus capable). */
export function hasMidline(marks: PitchMark[]): boolean {
  const names = new Set(marks.map((m) => m.name))
  return MIDLINE_MARK_NAMES.every((n) => names.has(n))
}
