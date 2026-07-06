import { describe, it, expect } from 'vitest'
import { createTranslator } from 'next-intl'
import {
  parse,
  TYPE,
  type MessageFormatElement,
} from '@formatjs/icu-messageformat-parser'
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

// ICU arguments like {url}, {count, plural, ...} — extracted with the real
// ICU parser: a regex misreads Latin plural-branch literals such as
// "one {recording}" as arguments.
function collectArgs(elements: MessageFormatElement[], args: Set<string>) {
  for (const el of elements) {
    if (el.type !== TYPE.literal && el.type !== TYPE.pound && 'value' in el) {
      args.add(String(el.value))
    }
    if (el.type === TYPE.plural || el.type === TYPE.select) {
      for (const option of Object.values(el.options)) {
        collectArgs(option.value, args)
      }
    }
    if (el.type === TYPE.tag) {
      collectArgs(el.children, args)
    }
  }
}

function icuArgs(message: string): string[] {
  const args = new Set<string>()
  collectArgs(parse(message, { ignoreTag: false }), args)
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

describe('Arabic digit pinning', () => {
  // Chrome renders Eastern Arabic digits (٠١٢) for plain 'ar'; Node renders
  // Latin. ar-u-nu-arab forces the Chrome behavior so this test is
  // deterministic across engines. Interpolated numbers must come out Latin
  // via the named 'latn' number format (i18n/request.ts).
  const t = createTranslator({
    locale: 'ar-u-nu-arab',
    messages: ar as Parameters<typeof createTranslator>[0]['messages'],
    formats: { number: { latn: { numberingSystem: 'latn' } } },
  })

  it('renders Latin digits in plural counts', () => {
    expect(t('venue.recordings.count', { count: 15 })).toMatch(/15/)
  })

  it('renders Latin digits in numeric interpolations', () => {
    expect(
      t('venue.recordings.pageRange', { from: 1, to: 20, total: 143 })
    ).toMatch(/1.*20.*143/)
    expect(t('auditHistory.daysAgo', { count: 5 })).toMatch(/5/)
  })
})
