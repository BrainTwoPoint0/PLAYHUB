'use client'

import { useState } from 'react'
import { useLocale } from 'next-intl'
import { usePathname, useRouter } from '@/i18n/navigation'
import { routing, type Locale } from '@/i18n/routing'
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@braintwopoint0/playback-commons/ui'
import { Check, Globe } from 'lucide-react'
import { cn } from '@braintwopoint0/playback-commons/utils'

// Each language names itself in its own script — the convention that stays
// readable no matter which locale the page is currently in. Keyed loosely so
// entries can sit here before their locale joins routing.locales (es).
const LOCALE_NAMES: Record<string, string> = {
  en: 'English',
  ar: 'العربية',
  es: 'Español',
}

export function LanguageSwitcher({
  className,
  onSwitched,
}: {
  className?: string
  onSwitched?: () => void
}) {
  const locale = useLocale()
  const router = useRouter()
  const pathname = usePathname()
  const [open, setOpen] = useState(false)

  const current = (routing.locales as readonly string[]).includes(locale)
    ? (locale as Locale)
    : routing.defaultLocale

  function switchTo(target: Locale) {
    setOpen(false)
    if (target !== current) {
      // window.location.search instead of useSearchParams(): NavBar renders
      // in the layout of statically generated pages, and useSearchParams
      // would force a Suspense/CSR bailout there.
      const query = typeof window !== 'undefined' ? window.location.search : ''
      router.replace(pathname + query, { locale: target })
    }
    onSwitched?.()
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          className={cn(
            'inline-flex items-center gap-2 rounded-md text-sm text-muted-foreground',
            'hover:text-[var(--timberwolf)] hover:bg-accent/50 transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--timberwolf)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--night)]',
            className
          )}
        >
          <Globe className="h-4 w-4 shrink-0" />
          <span lang={current}>{LOCALE_NAMES[current]}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-40 bg-card border-border p-1">
        {routing.locales.map((l) => (
          <button
            key={l}
            type="button"
            lang={l}
            onClick={() => switchTo(l)}
            className={cn(
              'flex w-full items-center justify-between rounded-sm px-2.5 py-1.5 text-sm transition-colors',
              l === current
                ? 'text-[var(--timberwolf)] font-medium'
                : 'text-muted-foreground hover:text-[var(--timberwolf)] hover:bg-accent/50'
            )}
          >
            {LOCALE_NAMES[l]}
            {l === current && <Check className="h-3.5 w-3.5 shrink-0" />}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}
