import { describe, it, expect } from 'vitest'
import en from '../../../messages/en.json'
import ar from '../../../messages/ar.json'
import es from '../../../messages/es.json'

type Messages = Record<string, unknown>

function flatten(obj: Messages, prefix = ''): Map<string, string> {
  const out = new Map<string, string>()
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') {
      out.set(path, value)
    } else if (value && typeof value === 'object') {
      for (const [k, v] of flatten(value as Messages, path)) {
        out.set(k, v)
      }
    }
  }
  return out
}

// ICU arguments like {url}, {count, plural, ...} — capture the argument name.
function icuArgs(message: string): string[] {
  const args = new Set<string>()
  for (const match of message.matchAll(/\{\s*([a-zA-Z0-9_]+)/g)) {
    args.add(match[1])
  }
  return [...args].sort()
}

const enFlat = flatten(en as Messages)

describe.each([
  ['ar', ar as Messages],
  ['es', es as Messages],
])('%s.json', (_name, messages) => {
  const flat = flatten(messages)

  it('only contains keys that exist in en.json', () => {
    const orphans = [...flat.keys()].filter((k) => !enFlat.has(k))
    expect(orphans).toEqual([])
  })

  it('preserves ICU placeholders from the English source', () => {
    const mismatches: string[] = []
    for (const [key, value] of flat) {
      const source = enFlat.get(key)
      if (source && icuArgs(source).join(',') !== icuArgs(value).join(',')) {
        mismatches.push(key)
      }
    }
    expect(mismatches).toEqual([])
  })

  it('has no empty values', () => {
    const empty = [...flat.entries()]
      .filter(([, v]) => v.trim() === '')
      .map(([k]) => k)
    expect(empty).toEqual([])
  })
})

describe('en.json', () => {
  it('has no empty values', () => {
    const empty = [...enFlat.entries()]
      .filter(([, v]) => v.trim() === '')
      .map(([k]) => k)
    expect(empty).toEqual([])
  })
})
