import { describe, it, expect } from 'vitest'
import {
  EVENT_TYPES,
  EVENT_TYPE_LABELS,
  EVENT_TYPE_COLORS,
  formatTimestamp,
  isValidEventType,
} from '../event-types'

describe('EVENT_TYPES', () => {
  it('contains 14 event types', () => {
    expect(EVENT_TYPES).toHaveLength(14)
  })

  it('includes core football events', () => {
    expect(EVENT_TYPES).toContain('goal')
    expect(EVENT_TYPES).toContain('shot')
    expect(EVENT_TYPES).toContain('save')
    expect(EVENT_TYPES).toContain('corner')
    expect(EVENT_TYPES).toContain('free_kick')
    expect(EVENT_TYPES).toContain('yellow_card')
    expect(EVENT_TYPES).toContain('red_card')
    expect(EVENT_TYPES).toContain('penalty')
  })

  it('includes match phase events', () => {
    expect(EVENT_TYPES).toContain('kick_off')
    expect(EVENT_TYPES).toContain('half_time')
    expect(EVENT_TYPES).toContain('full_time')
  })
})

describe('EVENT_TYPE_LABELS', () => {
  it('has a label for every event type', () => {
    for (const type of EVENT_TYPES) {
      expect(EVENT_TYPE_LABELS[type]).toBeDefined()
      expect(typeof EVENT_TYPE_LABELS[type]).toBe('string')
      expect(EVENT_TYPE_LABELS[type].length).toBeGreaterThan(0)
    }
  })

  it('returns expected display names', () => {
    expect(EVENT_TYPE_LABELS.goal).toBe('Goal')
    expect(EVENT_TYPE_LABELS.yellow_card).toBe('Yellow Card')
    expect(EVENT_TYPE_LABELS.free_kick).toBe('Free Kick')
    expect(EVENT_TYPE_LABELS.half_time).toBe('Half Time')
  })
})

describe('EVENT_TYPE_COLORS', () => {
  it('has a color for every event type', () => {
    for (const type of EVENT_TYPES) {
      expect(EVENT_TYPE_COLORS[type]).toBeDefined()
      expect(EVENT_TYPE_COLORS[type]).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })

  it('uses distinct colors for important events', () => {
    expect(EVENT_TYPE_COLORS.goal).not.toBe(EVENT_TYPE_COLORS.red_card)
    expect(EVENT_TYPE_COLORS.yellow_card).not.toBe(EVENT_TYPE_COLORS.red_card)
  })
})

describe('formatTimestamp', () => {
  it('formats seconds under a minute', () => {
    expect(formatTimestamp(0)).toBe('0:00')
    expect(formatTimestamp(5)).toBe('0:05')
    expect(formatTimestamp(30)).toBe('0:30')
    expect(formatTimestamp(59)).toBe('0:59')
  })

  it('formats minutes and seconds', () => {
    expect(formatTimestamp(60)).toBe('1:00')
    expect(formatTimestamp(90)).toBe('1:30')
    expect(formatTimestamp(125)).toBe('2:05')
    expect(formatTimestamp(599)).toBe('9:59')
  })

  it('formats hours', () => {
    expect(formatTimestamp(3600)).toBe('1:00:00')
    expect(formatTimestamp(3661)).toBe('1:01:01')
    expect(formatTimestamp(7200)).toBe('2:00:00')
  })

  it('handles decimal seconds by flooring', () => {
    expect(formatTimestamp(61.7)).toBe('1:01')
    expect(formatTimestamp(0.9)).toBe('0:00')
  })
})

describe('isValidEventType', () => {
  it('returns true for valid event types', () => {
    expect(isValidEventType('goal')).toBe(true)
    expect(isValidEventType('shot')).toBe(true)
    expect(isValidEventType('other')).toBe(true)
  })

  it('returns false for invalid event types', () => {
    expect(isValidEventType('invalid')).toBe(false)
    expect(isValidEventType('')).toBe(false)
    expect(isValidEventType('GOAL')).toBe(false)
  })
})
