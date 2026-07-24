import { describe, it, expect } from 'vitest'
import { LIKELY_GOAL_MIN, showLikelyGoal } from '../confidence'

describe('showLikelyGoal — badge rule (recorded signal only)', () => {
  it('badges at and above the floor', () => {
    expect(showLikelyGoal(LIKELY_GOAL_MIN)).toBe(true)
    expect(showLikelyGoal(0.99)).toBe(true)
  })

  it('stays silent below the floor', () => {
    expect(showLikelyGoal(LIKELY_GOAL_MIN - 0.001)).toBe(false)
    expect(showLikelyGoal(0)).toBe(false)
  })

  it('NULL (pre-refiner rows) never badges — and never reads as 0', () => {
    expect(showLikelyGoal(null)).toBe(false)
  })

  it('the floor is the curve-derived 0.85 (retune deliberately, not by drift)', () => {
    expect(LIKELY_GOAL_MIN).toBe(0.85)
  })
})
