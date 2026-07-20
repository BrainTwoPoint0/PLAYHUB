import { describe, it, expect } from 'vitest'
import {
  geometryReacquireEnabled,
  colocatedUpgradeAllowed,
  slotWatchNumber,
} from '../spotlight-reacquire'

describe('geometryReacquireEnabled', () => {
  it('is ON for an unlabelled Lock (circle-catch preserved)', () => {
    expect(geometryReacquireEnabled(null)).toBe(true)
  })
  it('is OFF for a slotted Lock — re-acquire only via slotMate', () => {
    expect(geometryReacquireEnabled('a10')).toBe(false)
    expect(geometryReacquireEnabled('a10-2')).toBe(false)
    expect(geometryReacquireEnabled('g1')).toBe(false)
  })
})

describe('colocatedUpgradeAllowed', () => {
  it('refuses ANY upgrade onto a slotted Lock (scenario b — #10 never becomes #5)', () => {
    expect(colocatedUpgradeAllowed('a10', 'a5', true)).toBe(false)
    expect(colocatedUpgradeAllowed('a10', 'a5', false)).toBe(false)
    expect(colocatedUpgradeAllowed('a10', 'a10', true)).toBe(false) // already slotted; slotMate owns it
  })
  it('refuses upgrading an unlabelled Lock from a NON-co-located labelled pickup (scenario a)', () => {
    expect(colocatedUpgradeAllowed(null, 'a5', false)).toBe(false)
  })
  it('allows upgrading an unlabelled Lock from a CO-LOCATED labelled pickup (same body gains its label)', () => {
    expect(colocatedUpgradeAllowed(null, 'a5', true)).toBe(true)
  })
  it('refuses when the pickup carries no slot', () => {
    expect(colocatedUpgradeAllowed(null, undefined, true)).toBe(false)
  })
})

describe('slotWatchNumber', () => {
  it('extracts the jersey number from a kit slot', () => {
    expect(slotWatchNumber('a10')).toBe('10')
    expect(slotWatchNumber('b7')).toBe('7')
    expect(slotWatchNumber('f23')).toBe('23')
  })
  it('extracts the number from a duplicate sub-slot', () => {
    expect(slotWatchNumber('a10-2')).toBe('10')
  })
  it('returns null for GK zone slots and null', () => {
    expect(slotWatchNumber('g1')).toBeNull()
    expect(slotWatchNumber('g4')).toBeNull()
    expect(slotWatchNumber(null)).toBeNull()
  })
  it('reads a kit letter beyond a–f (>6 clusters) — the grammar admits a–z', () => {
    expect(slotWatchNumber('h9')).toBe('9')
    expect(slotWatchNumber('z10')).toBe('10')
  })
})
