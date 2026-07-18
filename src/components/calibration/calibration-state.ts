// Pure state machine for the pitch-calibration marking flow. No DOM, no
// three.js — the CalibrationSurface reports picks/drags as events and the
// side panel renders from this state, so the whole flow is unit-testable.
//
// Phases:
//   placing(queue)  — ordered prompts; queue[0] is the mark the next click places
//   midline_offer   — all 4 corners placed; add the midline or skip it
//   adjusting       — everything placed; drag/nudge/re-place, dims editable
//   solving         — PUT in flight
//   result          — solve returned; operator accepts or redoes
//
// The midline is optional but both-or-neither (validateMarks). Corners are
// never deletable — only re-placed. Proposal/active-row seeds jump straight
// to adjusting when complete (they're draggable starting quads by design);
// missing corners re-enter the placing queue.

import {
  CORNER_MARK_NAMES,
  MIDLINE_MARK_NAMES,
  PITCH_LENGTH_BOUNDS,
  PITCH_WIDTH_BOUNDS,
  type MarkName,
  type PitchMark,
} from '@/lib/panorama/pitch-marks'

export type CalibrationPhase =
  | { kind: 'placing'; queue: MarkName[] }
  | { kind: 'midline_offer' }
  | { kind: 'adjusting' }
  | { kind: 'solving' }
  | { kind: 'result' }

export interface SolveSummary {
  reprojectionErrorPx: number
  perMarkErrorRad: Record<string, number>
  perMarkErrorPx?: Record<string, number>
}

export interface CalibrationState {
  phase: CalibrationPhase
  marks: PitchMark[]
  selected: MarkName | null
  /** Mark named by a 422 mark_unprojectable — highlighted until moved. */
  errorMark: MarkName | null
  /** Non-mark save failure code (mesh_unavailable, internal, …) for a banner. */
  errorCode: string | null
  lengthM: number
  widthM: number
  solve: SolveSummary | null
  midlineOffered: boolean
}

export type CalibrationEvent =
  | { type: 'SEED'; marks: PitchMark[] }
  | { type: 'PLACE'; uv: [number, number] }
  | { type: 'DRAG'; name: MarkName; uv: [number, number] }
  | { type: 'SELECT'; name: MarkName | null }
  | { type: 'REPLACE_MARK'; name: MarkName }
  | { type: 'ADD_MIDLINE' }
  | { type: 'SKIP_MIDLINE' }
  | { type: 'DELETE_MIDLINE' }
  | { type: 'SET_DIMS'; lengthM: number; widthM: number }
  | { type: 'SAVE' }
  | { type: 'SOLVE_OK'; solve: SolveSummary }
  | { type: 'SOLVE_ERR'; code: string; markName?: MarkName }
  | { type: 'REDO' }

export function initialCalibrationState(seed?: {
  marks?: PitchMark[]
  lengthM?: number
  widthM?: number
}): CalibrationState {
  const marks = seed?.marks ?? []
  const base: CalibrationState = {
    phase: { kind: 'placing', queue: [...CORNER_MARK_NAMES] },
    marks,
    selected: null,
    errorMark: null,
    errorCode: null,
    // NaN = "not entered yet": dimsValid blocks Save until the admin types
    // real dimensions — a prefilled default ships wrong metric outputs that
    // reprojection error cannot see (uniform scale).
    lengthM: seed?.lengthM ?? NaN,
    widthM: seed?.widthM ?? NaN,
    solve: null,
    midlineOffered: false,
  }
  return { ...base, phase: phaseAfterPlacement(base) }
}

function has(marks: PitchMark[], name: MarkName): boolean {
  return marks.some((m) => m.name === name)
}

function upsert(
  marks: PitchMark[],
  name: MarkName,
  uv: [number, number]
): PitchMark[] {
  const next = marks.filter((m) => m.name !== name)
  next.push({ name, uv })
  return next
}

export function missingCorners(marks: PitchMark[]): MarkName[] {
  return CORNER_MARK_NAMES.filter((n) => !has(marks, n))
}

export function hasFullMidline(marks: PitchMark[]): boolean {
  return MIDLINE_MARK_NAMES.every((n) => has(marks, n))
}

/**
 * Verdict band for a solve's max reprojection error, RELATIVE to the pitch's
 * on-screen size (max pairwise corner distance in raw-frame px). Absolute
 * thresholds mislead: 32px is huge on a pitch spanning 300px and ~1% on one
 * spanning 3000px — and venue meshes carry residual lens distortion that no
 * homography can absorb, so a well-marked pitch on an imperfect fit lands
 * around 0.5–1.5%. That reads "usable", never "your marks are wrong".
 */
export function solveErrorBand(
  errPx: number,
  marks: PitchMark[]
): 'good' | 'ok' | 'bad' {
  if (!Number.isFinite(errPx)) return 'bad'
  const corners = marks.filter((m) =>
    (CORNER_MARK_NAMES as readonly string[]).includes(m.name)
  )
  let diag = 0
  for (let i = 0; i < corners.length; i++) {
    for (let j = i + 1; j < corners.length; j++) {
      diag = Math.max(
        diag,
        Math.hypot(
          corners[i].uv[0] - corners[j].uv[0],
          corners[i].uv[1] - corners[j].uv[1]
        )
      )
    }
  }
  if (diag <= 0) return errPx < 15 ? 'good' : errPx < 45 ? 'ok' : 'bad'
  const rel = errPx / diag
  return rel < 0.005 ? 'good' : rel < 0.015 ? 'ok' : 'bad'
}

/** The mark the next surface click will place, or null outside placing. */
export function nextMark(state: CalibrationState): MarkName | null {
  return state.phase.kind === 'placing' ? (state.phase.queue[0] ?? null) : null
}

export function dimsValid(state: CalibrationState): boolean {
  return (
    Number.isFinite(state.lengthM) &&
    state.lengthM >= PITCH_LENGTH_BOUNDS[0] &&
    state.lengthM <= PITCH_LENGTH_BOUNDS[1] &&
    Number.isFinite(state.widthM) &&
    state.widthM >= PITCH_WIDTH_BOUNDS[0] &&
    state.widthM <= PITCH_WIDTH_BOUNDS[1]
  )
}

export function canSave(state: CalibrationState): boolean {
  const midlineCount = MIDLINE_MARK_NAMES.filter((n) =>
    has(state.marks, n)
  ).length
  return (
    state.phase.kind === 'adjusting' &&
    missingCorners(state.marks).length === 0 &&
    (midlineCount === 0 || midlineCount === MIDLINE_MARK_NAMES.length) &&
    dimsValid(state)
  )
}

/** Where an empty placing queue lands: offer the midline exactly once. */
function phaseAfterPlacement(state: CalibrationState): CalibrationPhase {
  const corners = missingCorners(state.marks)
  if (corners.length > 0) return { kind: 'placing', queue: corners }
  const midline = MIDLINE_MARK_NAMES.filter((n) => !has(state.marks, n))
  if (midline.length > 0 && midline.length < MIDLINE_MARK_NAMES.length)
    return { kind: 'placing', queue: midline }
  if (midline.length === MIDLINE_MARK_NAMES.length && !state.midlineOffered)
    return { kind: 'midline_offer' }
  return { kind: 'adjusting' }
}

export function calibrationReducer(
  state: CalibrationState,
  event: CalibrationEvent
): CalibrationState {
  switch (event.type) {
    case 'SEED': {
      const next = {
        ...state,
        marks: event.marks,
        errorMark: null,
        // seeded corners must be verified/dragged before anything else —
        // don't interrupt with the midline offer (it stays available as the
        // Add button in adjusting)
        midlineOffered:
          state.midlineOffered || missingCorners(event.marks).length === 0,
      }
      return { ...next, phase: phaseAfterPlacement(next) }
    }
    case 'PLACE': {
      if (state.phase.kind !== 'placing') return state
      const name = state.phase.queue[0]
      if (!name) return state
      const next = {
        ...state,
        marks: upsert(state.marks, name, event.uv),
        selected: name,
        errorMark: state.errorMark === name ? null : state.errorMark,
      }
      const queue = state.phase.queue.slice(1)
      return {
        ...next,
        phase: queue.length
          ? { kind: 'placing', queue }
          : phaseAfterPlacement(next),
      }
    }
    case 'DRAG': {
      if (
        state.phase.kind === 'solving' ||
        state.phase.kind === 'result' ||
        !has(state.marks, event.name)
      )
        return state
      return {
        ...state,
        marks: upsert(state.marks, event.name, event.uv),
        errorMark: state.errorMark === event.name ? null : state.errorMark,
      }
    }
    case 'SELECT':
      return { ...state, selected: event.name }
    case 'REPLACE_MARK': {
      if (state.phase.kind !== 'adjusting') return state
      return {
        ...state,
        selected: event.name,
        phase: { kind: 'placing', queue: [event.name] },
      }
    }
    case 'ADD_MIDLINE': {
      if (
        state.phase.kind !== 'midline_offer' &&
        state.phase.kind !== 'adjusting'
      )
        return state
      const queue = MIDLINE_MARK_NAMES.filter((n) => !has(state.marks, n))
      if (!queue.length) return state
      return {
        ...state,
        midlineOffered: true,
        phase: { kind: 'placing', queue },
      }
    }
    case 'SKIP_MIDLINE': {
      if (state.phase.kind !== 'midline_offer') return state
      return { ...state, midlineOffered: true, phase: { kind: 'adjusting' } }
    }
    case 'DELETE_MIDLINE': {
      if (state.phase.kind !== 'adjusting') return state
      return {
        ...state,
        midlineOffered: true,
        marks: state.marks.filter(
          (m) => !(MIDLINE_MARK_NAMES as readonly string[]).includes(m.name)
        ),
        selected: (MIDLINE_MARK_NAMES as readonly string[]).includes(
          state.selected ?? ''
        )
          ? null
          : state.selected,
      }
    }
    case 'SET_DIMS':
      return { ...state, lengthM: event.lengthM, widthM: event.widthM }
    case 'SAVE': {
      if (!canSave(state)) return state
      return { ...state, phase: { kind: 'solving' }, errorCode: null }
    }
    case 'SOLVE_OK': {
      if (state.phase.kind !== 'solving') return state
      return { ...state, phase: { kind: 'result' }, solve: event.solve }
    }
    case 'SOLVE_ERR': {
      if (state.phase.kind !== 'solving') return state
      return {
        ...state,
        phase: { kind: 'adjusting' },
        errorMark: event.markName ?? null,
        errorCode: event.markName ? null : event.code,
        selected: event.markName ?? state.selected,
      }
    }
    case 'REDO': {
      if (state.phase.kind !== 'result') return state
      return { ...state, phase: { kind: 'adjusting' }, solve: null }
    }
    default:
      return state
  }
}
