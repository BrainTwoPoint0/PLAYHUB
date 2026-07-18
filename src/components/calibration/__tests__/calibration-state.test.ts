import { describe, expect, it } from 'vitest'

import {
  calibrationReducer,
  canSave,
  dimsValid,
  hasFullMidline,
  initialCalibrationState,
  missingCorners,
  nextMark,
  solveErrorBand,
  type CalibrationEvent,
  type CalibrationState,
} from '../calibration-state'
import type { MarkName, PitchMark } from '@/lib/panorama/pitch-marks'

const uv = (x: number, y: number): [number, number] => [x, y]
const mark = (name: MarkName, x = 100, y = 100): PitchMark => ({
  name,
  uv: [x, y],
})

const CORNERS: MarkName[] = ['corner_nw', 'corner_ne', 'corner_se', 'corner_sw']

function run(
  state: CalibrationState,
  ...events: CalibrationEvent[]
): CalibrationState {
  return events.reduce(calibrationReducer, state)
}

describe('initialCalibrationState', () => {
  it('starts placing all four corners in order, dims NOT prefilled', () => {
    const s = initialCalibrationState()
    expect(s.phase).toEqual({ kind: 'placing', queue: CORNERS })
    expect(nextMark(s)).toBe('corner_nw')
    // NaN = admin must enter real dims; a prefilled default could ship a
    // green solve with silently wrong metric outputs
    expect(Number.isNaN(s.lengthM)).toBe(true)
    expect(Number.isNaN(s.widthM)).toBe(true)
    expect(dimsValid(s)).toBe(false)
  })

  it('a full corner SEED lands in adjusting (no midline-offer interrupt)', () => {
    const s = calibrationReducer(initialCalibrationState(), {
      type: 'SEED',
      marks: CORNERS.map((n) => mark(n)),
    })
    expect(s.phase.kind).toBe('adjusting')
    expect(s.midlineOffered).toBe(true)
  })

  it('a partial seed re-enters placing with only the missing corners', () => {
    const s = initialCalibrationState({
      marks: [mark('corner_nw'), mark('corner_se')],
    })
    expect(s.phase).toEqual({
      kind: 'placing',
      queue: ['corner_ne', 'corner_sw'],
    })
  })

  it('a seed with corners + midline lands in adjusting', () => {
    const s = initialCalibrationState({
      marks: [...CORNERS, 'midline_n', 'midline_s'].map((n) =>
        mark(n as MarkName)
      ),
    })
    expect(s.phase.kind).toBe('adjusting')
  })
})

describe('ordered placement', () => {
  it('places corners in order then offers the midline', () => {
    let s = initialCalibrationState()
    for (let i = 0; i < 4; i++) {
      expect(nextMark(s)).toBe(CORNERS[i])
      s = run(s, { type: 'PLACE', uv: uv(10 * (i + 1), 20) })
    }
    expect(missingCorners(s.marks)).toEqual([])
    expect(s.phase.kind).toBe('midline_offer')
    expect(s.selected).toBe('corner_sw')
  })

  it('PLACE outside placing is a no-op', () => {
    const s = initialCalibrationState({ marks: CORNERS.map((n) => mark(n)) })
    expect(run(s, { type: 'PLACE', uv: uv(1, 1) })).toBe(s)
  })

  it('ADD_MIDLINE queues both endpoints; placing them reaches adjusting', () => {
    let s = initialCalibrationState({ marks: CORNERS.map((n) => mark(n)) })
    s = run(s, { type: 'ADD_MIDLINE' })
    expect(s.phase).toEqual({
      kind: 'placing',
      queue: ['midline_n', 'midline_s'],
    })
    s = run(
      s,
      { type: 'PLACE', uv: uv(50, 5) },
      { type: 'PLACE', uv: uv(50, 95) }
    )
    expect(s.phase.kind).toBe('adjusting')
    expect(hasFullMidline(s.marks)).toBe(true)
  })

  it('SKIP_MIDLINE goes to adjusting and the offer never repeats', () => {
    let s = initialCalibrationState({ marks: CORNERS.map((n) => mark(n)) })
    s = run(s, { type: 'SKIP_MIDLINE' })
    expect(s.phase.kind).toBe('adjusting')
    // re-placing a corner returns to adjusting, not the offer
    s = run(
      s,
      { type: 'REPLACE_MARK', name: 'corner_nw' },
      { type: 'PLACE', uv: uv(7, 7) }
    )
    expect(s.phase.kind).toBe('adjusting')
    expect(s.marks.find((m) => m.name === 'corner_nw')!.uv).toEqual([7, 7])
  })
})

describe('adjusting', () => {
  const placed = (): CalibrationState =>
    run(
      initialCalibrationState({ marks: CORNERS.map((n) => mark(n)) }),
      { type: 'SKIP_MIDLINE' },
      { type: 'SET_DIMS', lengthM: 100, widthM: 64 }
    )

  it('DRAG moves an existing mark and clears its error highlight', () => {
    let s: CalibrationState = { ...placed(), errorMark: 'corner_ne' }
    s = run(s, { type: 'DRAG', name: 'corner_ne', uv: uv(500, 600) })
    expect(s.marks.find((m) => m.name === 'corner_ne')!.uv).toEqual([500, 600])
    expect(s.errorMark).toBeNull()
  })

  it('DRAG on an unplaced mark is a no-op', () => {
    const s = placed()
    expect(run(s, { type: 'DRAG', name: 'midline_n', uv: uv(1, 1) })).toBe(s)
  })

  it('DELETE_MIDLINE removes both endpoints', () => {
    let s = run(
      placed(),
      { type: 'ADD_MIDLINE' },
      { type: 'PLACE', uv: uv(50, 5) },
      { type: 'PLACE', uv: uv(50, 95) }
    )
    expect(hasFullMidline(s.marks)).toBe(true)
    s = run(s, { type: 'DELETE_MIDLINE' })
    expect(s.marks.some((m) => m.name.startsWith('midline'))).toBe(false)
    expect(s.phase.kind).toBe('adjusting')
  })
})

describe('solveErrorBand (relative to pitch pixel span)', () => {
  // pitch spanning ~3000px diagonally (the real Nazwa scale)
  const wideMarks: PitchMark[] = [
    mark('corner_nw', 400, 700),
    mark('corner_ne', 2800, 600),
    mark('corner_se', 3500, 1300),
    mark('corner_sw', 400, 1400),
  ]
  it('~1% relative error on a wide pitch is USABLE, not bad', () => {
    // the Nazwa pilot case: 31.8px on a ~3118px span — venue-fit residual
    expect(solveErrorBand(31.8, wideMarks)).toBe('ok')
  })
  it('sub-0.5% is good, past 1.5% is bad', () => {
    expect(solveErrorBand(10, wideMarks)).toBe('good')
    expect(solveErrorBand(60, wideMarks)).toBe('bad')
  })
  it('the same 32px on a tiny on-screen pitch is bad', () => {
    const tiny: PitchMark[] = [
      mark('corner_nw', 100, 100),
      mark('corner_ne', 400, 100),
      mark('corner_se', 400, 300),
      mark('corner_sw', 100, 300),
    ]
    expect(solveErrorBand(32, tiny)).toBe('bad')
  })
  it('degrades to absolute thresholds without corners', () => {
    expect(solveErrorBand(10, [])).toBe('good')
    expect(solveErrorBand(30, [])).toBe('ok')
    expect(solveErrorBand(60, [])).toBe('bad')
    expect(solveErrorBand(NaN, wideMarks)).toBe('bad')
  })
})

describe('save / solve', () => {
  const ready = (): CalibrationState =>
    run(
      initialCalibrationState({ marks: CORNERS.map((n) => mark(n)) }),
      { type: 'SKIP_MIDLINE' },
      { type: 'SET_DIMS', lengthM: 100, widthM: 64 }
    )

  it('canSave requires adjusting + all corners + valid dims', () => {
    expect(canSave(ready())).toBe(true)
    expect(canSave(initialCalibrationState())).toBe(false)
    const badDims = run(ready(), { type: 'SET_DIMS', lengthM: 5, widthM: 64 })
    expect(dimsValid(badDims)).toBe(false)
    expect(canSave(badDims)).toBe(false)
    const nan = run(ready(), { type: 'SET_DIMS', lengthM: NaN, widthM: 64 })
    expect(canSave(nan)).toBe(false)
  })

  it('SAVE → SOLVE_OK reaches result with the solve stored', () => {
    const solve = { reprojectionErrorPx: 8.4, perMarkErrorRad: {} }
    const s = run(ready(), { type: 'SAVE' }, { type: 'SOLVE_OK', solve })
    expect(s.phase.kind).toBe('result')
    expect(s.solve).toEqual(solve)
  })

  it('SOLVE_OK carries the server activation verdict into the result', () => {
    // red solves save WITHOUT activating — the result screen branches its
    // "now live" copy on this flag, and REDO must clear it with the solve
    const solve = {
      reprojectionErrorPx: 137.5,
      perMarkErrorRad: {},
      activated: false,
      band: 'bad' as const,
    }
    const s = run(ready(), { type: 'SAVE' }, { type: 'SOLVE_OK', solve })
    expect(s.solve?.activated).toBe(false)
    expect(s.solve?.band).toBe('bad')
    const redone = run(s, { type: 'REDO' })
    expect(redone.solve).toBeNull()
  })

  it('SAVE is refused outside a saveable state', () => {
    const s = initialCalibrationState()
    expect(run(s, { type: 'SAVE' })).toBe(s)
  })

  it('422 mark_unprojectable returns to adjusting with the mark highlighted and selected', () => {
    const s = run(
      ready(),
      { type: 'SAVE' },
      { type: 'SOLVE_ERR', code: 'mark_unprojectable', markName: 'corner_sw' }
    )
    expect(s.phase.kind).toBe('adjusting')
    expect(s.errorMark).toBe('corner_sw')
    expect(s.selected).toBe('corner_sw')
    expect(s.errorCode).toBeNull()
  })

  it('non-mark solve errors return to adjusting with a code banner', () => {
    const s = run(
      ready(),
      { type: 'SAVE' },
      { type: 'SOLVE_ERR', code: 'mesh_unavailable' }
    )
    expect(s.phase.kind).toBe('adjusting')
    expect(s.errorCode).toBe('mesh_unavailable')
    expect(s.errorMark).toBeNull()
  })

  it('DRAG is a no-op during solving and result — the saved row must match the screen', () => {
    const solve = { reprojectionErrorPx: 8, perMarkErrorRad: {} }
    const solving = run(ready(), { type: 'SAVE' })
    expect(
      run(solving, { type: 'DRAG', name: 'corner_nw', uv: uv(999, 999) })
    ).toBe(solving)
    const result = run(solving, { type: 'SOLVE_OK', solve })
    expect(
      run(result, { type: 'DRAG', name: 'corner_nw', uv: uv(999, 999) })
    ).toBe(result)
  })

  it('DELETE_MIDLINE latches the offer — re-placing a corner cannot resurrect it', () => {
    const s = run(
      ready(),
      { type: 'ADD_MIDLINE' },
      { type: 'PLACE', uv: uv(50, 5) },
      { type: 'PLACE', uv: uv(50, 95) },
      { type: 'DELETE_MIDLINE' },
      { type: 'REPLACE_MARK', name: 'corner_nw' },
      { type: 'PLACE', uv: uv(8, 8) }
    )
    expect(s.phase.kind).toBe('adjusting')
  })

  it('REDO returns from result to adjusting and clears the solve', () => {
    const solve = { reprojectionErrorPx: 40, perMarkErrorRad: {} }
    const s = run(
      ready(),
      { type: 'SAVE' },
      { type: 'SOLVE_OK', solve },
      { type: 'REDO' }
    )
    expect(s.phase.kind).toBe('adjusting')
    expect(s.solve).toBeNull()
    expect(canSave(s)).toBe(true)
  })
})
