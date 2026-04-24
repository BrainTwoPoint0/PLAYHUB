'use client'

import Link from 'next/link'
import {
  FooterCreditsBar,
  NewsletterForm,
} from '@braintwopoint0/playback-commons/ui'

type FooterLink = {
  label: string
  href: string
  external?: boolean
}

type FooterColumn = {
  title: string
  links: FooterLink[]
}

const columns: FooterColumn[] = [
  {
    title: 'Browse',
    links: [
      { label: 'Matches', href: '/matches' },
      { label: 'Academy', href: '/academy' },
    ],
  },
  {
    title: 'Account',
    links: [
      { label: 'Recordings', href: '/recordings' },
      { label: 'Sign in', href: '/auth/login' },
    ],
  },
  {
    title: 'Company',
    links: [
      {
        label: 'About PLAYBACK',
        href: 'https://playbacksports.ai',
        external: true,
      },
      {
        label: 'Press',
        href: 'https://playbacksports.ai/press',
        external: true,
      },
      {
        label: 'Contact',
        href: 'https://playbacksports.ai/#contact',
        external: true,
      },
    ],
  },
  {
    title: 'Legal',
    links: [
      { label: 'Terms', href: '/legal/terms' },
      {
        label: 'Privacy',
        href: 'https://playbacksports.ai/legal/privacy',
        external: true,
      },
      {
        label: 'Cookies',
        href: 'https://playbacksports.ai/legal/cookies',
        external: true,
      },
    ],
  },
]

const INK_MUTED = 'rgba(214,213,201,0.64)'
const INK_SUBTLE = 'rgba(214,213,201,0.44)'
const LINE = 'rgba(214,213,201,0.08)'

function FooterLinkItem({ link }: { link: FooterLink }) {
  const classes =
    'text-[14px] text-[rgba(214,213,201,0.64)] hover:text-[var(--timberwolf)] transition-colors rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--timberwolf)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--night)]'

  if (link.external) {
    return (
      <a
        href={link.href}
        target="_blank"
        rel="noopener noreferrer"
        className={classes}
      >
        {link.label}
      </a>
    )
  }

  return (
    <Link href={link.href} className={classes}>
      {link.label}
    </Link>
  )
}

export default function Footer() {
  return (
    <footer
      id="footer"
      className="mt-24 border-t bg-[var(--night)]"
      style={{ borderTopColor: LINE }}
      aria-labelledby="playhub-footer-heading"
    >
      <h2 id="playhub-footer-heading" className="sr-only">
        PLAYHUB site footer
      </h2>
      <div className="mx-auto max-w-[1400px] px-6 sm:px-10">
        <div className="flex flex-col gap-6 pt-16 pb-10 md:flex-row md:items-start md:justify-between md:gap-10 md:pt-20">
          <div className="max-w-[36ch]">
            <p
              className="text-[11px] uppercase tracking-[0.22em] font-semibold"
              style={{ color: INK_SUBTLE }}
            >
              Newsletter
            </p>
            <p className="mt-3 text-[17px] md:text-[19px] leading-[1.35] tracking-[-0.01em] text-[var(--timberwolf)]">
              Updates from the Network.
            </p>
            <p
              className="mt-2 text-[13px] leading-[1.5]"
              style={{ color: INK_MUTED }}
            >
              Only when relevant. No spam.
            </p>
          </div>
          <div className="w-full md:max-w-md md:pt-1">
            <NewsletterForm
              endpoint="https://playbacksports.ai/api/newsletter/subscribe"
              source="playhub-footer"
            />
          </div>
        </div>

        <div className="border-t py-14" style={{ borderTopColor: LINE }}>
          <div className="grid grid-cols-2 gap-x-6 gap-y-10 md:grid-cols-4">
            {columns.map((col) => (
              <nav key={col.title} aria-label={col.title}>
                <p
                  className="text-[12px] uppercase tracking-[0.14em] mb-4"
                  style={{ color: INK_SUBTLE }}
                >
                  {col.title}
                </p>
                <ul className="flex flex-col gap-3">
                  {col.links.map((link) => (
                    <li key={`${col.title}-${link.label}`}>
                      <FooterLinkItem link={link} />
                    </li>
                  ))}
                </ul>
              </nav>
            ))}
          </div>
        </div>

        <FooterCreditsBar />
      </div>
    </footer>
  )
}
