'use client'

import Link from 'next/link'
import Image from 'next/image'
import { useEffect, useRef, useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { createClient } from '@braintwopoint0/playback-commons/supabase'
import {
  ArrowRight,
  Play,
  Smartphone,
  CalendarCheck,
  ShieldCheck,
  Zap,
  MonitorPlay,
} from 'lucide-react'
import { FadeIn } from '@/components/FadeIn'
import {
  MatchParallaxHero,
  type ParallaxItem,
} from '@/components/landing/MatchParallaxHero'
import { StaticHero } from '@/components/landing/StaticHero'

const AMBER = 'rgb(224,173,98)'

/* ── Types ── */
type FeaturedMatch = {
  id: string
  title: string
  home_team: string
  away_team: string
  match_date: string
  venue?: string
  competition?: string
  thumbnail_url?: string
  sport?: { name: string } | null
  organization?: { name: string } | null
  products?: Array<{
    id: string
    price_amount: number
    currency: string
    is_available: boolean
  }>
}

/* ── Animated counter ── */
function CountUp({ target, suffix = '' }: { target: number; suffix?: string }) {
  const prefersReduced = useReducedMotion()
  const [count, setCount] = useState(target)
  const ref = useRef<HTMLSpanElement>(null)
  const started = useRef(false)

  useEffect(() => {
    if (prefersReduced) {
      setCount(target)
      return
    }
    const el = ref.current
    if (!el) return

    setCount(0)
    let rafId: number

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !started.current) {
          started.current = true
          const t0 = performance.now()
          const dur = 2000

          const tick = (now: number) => {
            const p = Math.min((now - t0) / dur, 1)
            const eased = 1 - Math.pow(1 - p, 3)
            setCount(Math.round(eased * target))
            if (p < 1) rafId = requestAnimationFrame(tick)
          }
          rafId = requestAnimationFrame(tick)
        }
      },
      { threshold: 0.3 }
    )

    observer.observe(el)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(rafId)
    }
  }, [target, prefersReduced])

  return (
    <span ref={ref} aria-label={`${target}${suffix}`}>
      {count}
      {suffix}
    </span>
  )
}

/* ── Data ── */
const stats = [
  { value: 1000, suffix: '+', label: 'Recordings' },
  { value: 25, suffix: '+', label: 'Clubs & academies' },
  { value: 50, suffix: '+', label: 'Venues' },
  { value: 10, suffix: '+', label: 'Countries' },
]

const trustLogos = [
  { name: 'Complete Football Academy', src: '/partners/cfa.png' },
  { name: 'Soccer Elite FA', src: '/partners/sefa.png' },
  { name: 'Hollands & Blair', src: '/partners/hb.png' },
  { name: 'Maidstone United', src: '/partners/maidstone.png' },
  { name: 'DAFL', src: '/partners/dafl.png' },
]

const features = [
  {
    icon: MonitorPlay,
    title: '4K Streaming',
    desc: 'Crystal clear 4K playback. Watch every detail of the game.',
  },
  {
    icon: Zap,
    title: 'Instant Access',
    desc: 'Start watching immediately after purchase. No waiting around.',
  },
  {
    icon: Smartphone,
    title: 'Any Device',
    desc: 'Watch on phone, tablet, or desktop. Your match travels with you.',
  },
  {
    icon: CalendarCheck,
    title: 'Academy Subscriptions',
    desc: 'Subscribe to your academy for instant access to every match recording, all season long.',
  },
  {
    icon: ShieldCheck,
    title: 'Secure Payments',
    desc: 'Powered by Stripe. Your payment details are always protected.',
  },
  {
    icon: Play,
    title: 'Your Library',
    desc: 'All purchases saved to your library. Rewatch anytime you want.',
  },
]

const steps = [
  {
    num: '01',
    title: 'Find your match',
    desc: 'Browse recordings by date, team, or competition. Filter to find exactly what you need.',
  },
  {
    num: '02',
    title: 'Get access',
    desc: 'One-time purchase, academy subscription, or shared link. Multiple ways to watch.',
  },
  {
    num: '03',
    title: 'Watch instantly',
    desc: 'Stream in HD from any device. Your purchase is saved forever.',
  },
]

/* ── Sample fixtures (fallback when real DB is empty or parallax needs 15) ── */
function sampleDate(offsetDays: number): string {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  d.setHours(14, 30, 0, 0)
  return d.toISOString()
}

function formatShortDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(d)
}

const SAMPLE_MATCHES: FeaturedMatch[] = [
  {
    id: 'sample-cfa-u16',
    title: 'CFA U16 vs Maidstone',
    home_team: 'CFA U16',
    away_team: 'Maidstone',
    match_date: sampleDate(2),
    venue: 'Waterden Park',
    competition: 'Junior Premier League',
    sport: { name: 'Football' },
    organization: { name: 'Complete Football Academy' },
    products: [
      { id: 's1', price_amount: 599, currency: 'GBP', is_available: true },
    ],
  },
  {
    id: 'sample-sefa-girls',
    title: 'SEFA Girls U14 Cup Final',
    home_team: 'SEFA Girls U14',
    away_team: 'Brighton YG',
    match_date: sampleDate(3),
    venue: 'Goals Beckenham',
    competition: 'Regional Cup',
    sport: { name: 'Football' },
    organization: { name: 'Soccer Elite FA' },
    products: [
      { id: 's2', price_amount: 499, currency: 'GBP', is_available: true },
    ],
  },
  {
    id: 'sample-hb',
    title: 'Hollands & Blair vs Tonbridge',
    home_team: 'Hollands & Blair',
    away_team: 'Tonbridge Angels',
    match_date: sampleDate(1),
    venue: 'Rainham Road',
    competition: 'Isthmian League',
    sport: { name: 'Football' },
    organization: { name: 'Hollands & Blair FC' },
    products: [
      { id: 's3', price_amount: 699, currency: 'GBP', is_available: true },
    ],
  },
  {
    id: 'sample-dafl',
    title: 'DAFL Tournament - Day 3',
    home_team: 'DAFL Select',
    away_team: 'Kent Warriors',
    match_date: sampleDate(4),
    venue: 'Dubai Sports City',
    competition: 'DAFL International',
    sport: { name: 'Football' },
    organization: { name: 'DAFL' },
    products: [
      { id: 's4', price_amount: 899, currency: 'GBP', is_available: true },
    ],
  },
  {
    id: 'sample-maidstone-u18',
    title: 'Maidstone United Academy',
    home_team: 'Maidstone U18',
    away_team: 'Charlton U18',
    match_date: sampleDate(5),
    venue: 'Gallagher Stadium',
    competition: 'Academy League',
    sport: { name: 'Football' },
    organization: { name: 'Maidstone United' },
    products: [
      { id: 's5', price_amount: 599, currency: 'GBP', is_available: true },
    ],
  },
  {
    id: 'sample-cfa-u14',
    title: 'CFA U14 Regional Qualifier',
    home_team: 'CFA U14',
    away_team: 'Arsenal Academy',
    match_date: sampleDate(6),
    venue: 'Waterden Park',
    competition: 'FA Youth Cup',
    sport: { name: 'Football' },
    organization: { name: 'Complete Football Academy' },
    products: [
      { id: 's6', price_amount: 599, currency: 'GBP', is_available: true },
    ],
  },
  {
    id: 'sample-sefa-boys',
    title: 'SEFA Boys U16 League',
    home_team: 'SEFA Boys U16',
    away_team: 'Millwall DC',
    match_date: sampleDate(7),
    venue: 'Goals Beckenham',
    competition: 'Junior Premier League',
    sport: { name: 'Football' },
    organization: { name: 'Soccer Elite FA' },
    products: [
      { id: 's7', price_amount: 499, currency: 'GBP', is_available: true },
    ],
  },
  {
    id: 'sample-dafl-u12',
    title: 'DAFL U12 Tournament Final',
    home_team: 'DAFL Eagles',
    away_team: 'Abu Dhabi FC',
    match_date: sampleDate(8),
    venue: 'Dubai Sports City',
    competition: 'DAFL Cup',
    sport: { name: 'Football' },
    organization: { name: 'DAFL' },
    products: [
      { id: 's8', price_amount: 699, currency: 'GBP', is_available: true },
    ],
  },
  {
    id: 'sample-hb-reserves',
    title: 'H&B Reserves vs Ashford',
    home_team: 'H&B Reserves',
    away_team: 'Ashford United',
    match_date: sampleDate(9),
    venue: 'Rainham Road',
    competition: 'Kent Senior Cup',
    sport: { name: 'Football' },
    organization: { name: 'Hollands & Blair FC' },
    products: [
      { id: 's9', price_amount: 599, currency: 'GBP', is_available: true },
    ],
  },
  {
    id: 'sample-maidstone-u14',
    title: 'Maidstone U14 Cup Tie',
    home_team: 'Maidstone U14',
    away_team: 'Gillingham Academy',
    match_date: sampleDate(10),
    venue: 'Gallagher Stadium',
    competition: 'Kent Youth Cup',
    sport: { name: 'Football' },
    organization: { name: 'Maidstone United' },
    products: [
      { id: 's10', price_amount: 499, currency: 'GBP', is_available: true },
    ],
  },
  {
    id: 'sample-cfa-girls',
    title: 'CFA Girls Development',
    home_team: 'CFA Girls',
    away_team: 'Fulham Girls',
    match_date: sampleDate(11),
    venue: 'Waterden Park',
    competition: 'Girls Development League',
    sport: { name: 'Football' },
    organization: { name: 'Complete Football Academy' },
    products: [
      { id: 's11', price_amount: 499, currency: 'GBP', is_available: true },
    ],
  },
  {
    id: 'sample-sefa-u12',
    title: 'SEFA U12 Saturday League',
    home_team: 'SEFA U12',
    away_team: 'Dulwich Hamlet',
    match_date: sampleDate(12),
    venue: 'Goals Beckenham',
    competition: 'Saturday League',
    sport: { name: 'Football' },
    organization: { name: 'Soccer Elite FA' },
    products: [
      { id: 's12', price_amount: 399, currency: 'GBP', is_available: true },
    ],
  },
  {
    id: 'sample-dafl-senior',
    title: 'DAFL Senior Cup Semi-Final',
    home_team: 'DAFL United',
    away_team: 'Sharjah Sports',
    match_date: sampleDate(13),
    venue: 'Dubai Sports City',
    competition: 'DAFL Senior Cup',
    sport: { name: 'Football' },
    organization: { name: 'DAFL' },
    products: [
      { id: 's13', price_amount: 899, currency: 'GBP', is_available: true },
    ],
  },
  {
    id: 'sample-hb-u18',
    title: 'H&B U18 Academy Match',
    home_team: 'H&B U18',
    away_team: 'Dover Academy',
    match_date: sampleDate(14),
    venue: 'Rainham Road',
    competition: 'Academy League',
    sport: { name: 'Football' },
    organization: { name: 'Hollands & Blair FC' },
    products: [
      { id: 's14', price_amount: 599, currency: 'GBP', is_available: true },
    ],
  },
  {
    id: 'sample-maidstone-first',
    title: 'Maidstone First Team',
    home_team: 'Maidstone United',
    away_team: 'Ebbsfleet',
    match_date: sampleDate(15),
    venue: 'Gallagher Stadium',
    competition: 'National League South',
    sport: { name: 'Football' },
    organization: { name: 'Maidstone United' },
    products: [
      { id: 's15', price_amount: 999, currency: 'GBP', is_available: true },
    ],
  },
]

function matchToParallax(m: FeaturedMatch): ParallaxItem {
  return {
    title: `${m.home_team} vs ${m.away_team}`,
    home: m.home_team,
    away: m.away_team,
    dateLabel: formatShortDate(m.match_date),
    club: m.organization?.name,
    href: `/matches/${m.id}`,
    thumbnail: m.thumbnail_url,
    sport: m.sport?.name,
  }
}

/* ── Page ── */
export default function HomePage() {
  const prefersReduced = useReducedMotion() ?? false
  const [mounted, setMounted] = useState(false)
  const [isDesktop, setIsDesktop] = useState(false)
  const [matches, setMatches] = useState<FeaturedMatch[]>([])
  const [matchesLoading, setMatchesLoading] = useState(true)

  useEffect(() => setMounted(true), [])

  /* Track desktop breakpoint for parallax-vs-static gate. */
  useEffect(() => {
    const mql = window.matchMedia('(min-width: 768px)')
    const update = () => setIsDesktop(mql.matches)
    update()
    mql.addEventListener('change', update)
    return () => mql.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    let cancelled = false
    async function fetchFeatured() {
      try {
        const supabase = createClient()
        const { data } = await (supabase as any)
          .from('playhub_match_recordings')
          .select(
            `
            id, title, home_team, away_team, match_date, venue, competition, thumbnail_url,
            sport:sports(name),
            organization:organizations!organization_id(name),
            products:playhub_products(id, price_amount, currency, is_available)
          `
          )
          .eq('status', 'published')
          .order('match_date', { ascending: false })
          .limit(20)

        if (cancelled) return
        // Source of truth for "listed" is playhub_products.is_available.
        // Drop recordings that have no available product so unlisted /
        // soft-deleted listings never appear on the homepage.
        const listed = (data ?? []).filter((m: any) =>
          (m.products || []).some((p: any) => p.is_available)
        )
        setMatches(listed)
      } catch {
        /* falls back to SAMPLE_MATCHES */
      } finally {
        if (!cancelled) setMatchesLoading(false)
      }
    }
    fetchFeatured()
    return () => {
      cancelled = true
    }
  }, [])

  /* Merge real + samples; real first, samples pad to 15.
   * Real matches with thumbnails bubble to the top. */
  const sorted = [...matches].sort((a, b) => {
    const aHas = a.thumbnail_url ? 1 : 0
    const bHas = b.thumbnail_url ? 1 : 0
    return bHas - aHas
  })
  const combined = [...sorted, ...SAMPLE_MATCHES]
  const parallaxItems: ParallaxItem[] = combined
    .slice(0, 15)
    .map(matchToParallax)
  const carouselMatches = (matches.length > 0 ? sorted : SAMPLE_MATCHES).slice(
    0,
    8
  )

  /* Render parallax only after mount (avoids SSR/hydration mismatch on
   * matchMedia) and only when desktop AND motion is allowed. */
  const showParallax = mounted && isDesktop && !prefersReduced

  return (
    <div className="bg-night overflow-hidden">
      {showParallax ? (
        <MatchParallaxHero items={parallaxItems}>
          <p className="flex items-center gap-3 text-[11px] uppercase tracking-[0.22em] text-ink-muted mb-6">
            <span
              aria-hidden
              className="inline-flex h-1.5 w-1.5 rounded-full"
              style={{ background: AMBER }}
            />
            The match recordings hub
          </p>
          <h1 className="font-semibold text-timberwolf text-[clamp(36px,6vw,80px)] leading-[1.02] tracking-[-0.035em] max-w-[20ch]">
            Your kid&apos;s matches.
            <br />
            <span className="text-ink-muted">All of them.</span>
          </h1>
          <p className="mt-6 text-[16px] md:text-[19px] leading-[1.5] text-ink-muted max-w-[54ch] [text-wrap:balance]">
            Full recordings from CFA, SEFA, Maidstone, DAFL and more - from the
            moment the whistle blows.
          </p>
          <div className="mt-8">
            <Link
              href="/matches"
              className="group inline-flex items-center justify-center gap-2 h-12 px-7 rounded-full text-[15px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(224,173,98)] focus-visible:ring-offset-2 focus-visible:ring-offset-night"
              style={{
                color: AMBER,
                border: `1px solid rgba(224,173,98,0.5)`,
                background: 'rgba(10,16,13,0.4)',
              }}
            >
              Browse matches
              <ArrowRight
                className="h-4 w-4 transition-transform duration-300 motion-reduce:transition-none group-hover:translate-x-0.5"
                aria-hidden
              />
            </Link>
          </div>
        </MatchParallaxHero>
      ) : (
        <StaticHero matches={matchesLoading ? [] : carouselMatches} />
      )}

      {/* ═══ TRUST STRIP ═══ */}
      <section className="border-t border-line">
        <div className="mx-auto max-w-[1400px] px-6 sm:px-10 py-10 md:py-12">
          <p className="text-[11px] uppercase tracking-[0.22em] text-ink-subtle mb-6">
            Hosting recordings from
          </p>
          <ul className="flex flex-wrap items-center gap-x-10 gap-y-5">
            {trustLogos.map((logo) => (
              <li key={logo.name} className="flex items-center">
                <Image
                  src={logo.src}
                  alt={logo.name}
                  width={80}
                  height={40}
                  className="h-7 md:h-9 w-auto object-contain opacity-70 grayscale hover:opacity-100 hover:grayscale-0 transition-all duration-300"
                />
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ═══ STATS ═══ */}
      <section className="border-t border-line">
        <div className="mx-auto max-w-[1400px] px-6 sm:px-10 py-14 md:py-20">
          <dl className="grid grid-cols-2 md:grid-cols-4 gap-8 md:gap-0">
            {stats.map((stat, i) => (
              <FadeIn
                key={stat.label}
                delay={i * 100}
                className={`${
                  i < stats.length - 1 ? 'md:border-r md:border-line' : ''
                }`}
              >
                <dd className="text-[clamp(32px,3.6vw,48px)] font-semibold tracking-[-0.02em] text-timberwolf leading-[1] tabular-nums mb-2">
                  <CountUp target={stat.value} suffix={stat.suffix} />
                </dd>
                <dt className="text-[11px] uppercase tracking-[0.16em] text-ink-subtle leading-[1.3]">
                  {stat.label}
                </dt>
              </FadeIn>
            ))}
          </dl>
        </div>
      </section>

      {/* ═══ FEATURES ═══ */}
      <section className="border-t border-line">
        <div className="mx-auto max-w-[1400px] px-6 sm:px-10 py-20 md:py-28">
          <FadeIn className="mb-12 md:mb-16">
            <p className="text-[11px] uppercase tracking-[0.16em] text-ink-subtle mb-3">
              Why PLAYHUB
            </p>
            <h2 className="text-[clamp(26px,4.5vw,48px)] font-semibold tracking-[-0.02em] leading-[1.05] text-timberwolf max-w-[22ch]">
              Everything you need to watch the game.
            </h2>
          </FadeIn>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-5">
            {features.map((f, i) => (
              <FadeIn
                key={f.title}
                delay={i * 70}
                className="group p-6 rounded-xl border border-line-strong bg-[rgba(214,213,201,0.02)] hover:border-timberwolf/30 hover:bg-[rgba(214,213,201,0.04)] transition-colors duration-300"
              >
                <span
                  aria-hidden
                  className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-line-strong bg-[rgba(214,213,201,0.03)] mb-4 transition-transform duration-300 group-hover:-translate-y-0.5"
                >
                  <f.icon className="w-4 h-4 text-timberwolf" />
                </span>
                <h3 className="text-timberwolf font-semibold mb-2">
                  {f.title}
                </h3>
                <p className="text-sm text-ink-muted leading-[1.55]">
                  {f.desc}
                </p>
              </FadeIn>
            ))}
          </div>
        </div>
      </section>

      {/* ═══ HOW IT WORKS ═══ */}
      <section className="border-t border-line">
        <div className="mx-auto max-w-[1400px] px-6 sm:px-10 py-20 md:py-28">
          <FadeIn className="mb-12 md:mb-16">
            <p className="text-[11px] uppercase tracking-[0.16em] text-ink-subtle mb-3">
              Simple process
            </p>
            <h2 className="text-[clamp(26px,4.5vw,48px)] font-semibold tracking-[-0.02em] leading-[1.05] text-timberwolf">
              Three steps to kickoff.
            </h2>
          </FadeIn>

          <div className="grid md:grid-cols-3 gap-10 md:gap-12">
            {steps.map((step, i) => (
              <FadeIn key={step.num} delay={i * 150} className="relative">
                <span
                  aria-hidden
                  className="block text-[clamp(40px,5vw,56px)] font-semibold tracking-[-0.03em] leading-[1] text-[rgba(214,213,201,0.28)] mb-3 tabular-nums"
                >
                  {step.num}
                </span>
                <h3 className="text-[17px] font-semibold text-timberwolf mb-2 tracking-[-0.01em]">
                  {step.title}
                </h3>
                <p className="text-sm text-ink-muted leading-[1.55] max-w-[40ch]">
                  {step.desc}
                </p>
              </FadeIn>
            ))}
          </div>
        </div>
      </section>

      {/* ═══ FOR CLUBS ═══ */}
      <section className="border-t border-line">
        <div className="mx-auto max-w-[1400px] px-6 sm:px-10 py-20 md:py-28">
          <FadeIn direction="left" className="max-w-2xl">
            <p className="text-[11px] uppercase tracking-[0.16em] text-ink-subtle mb-4">
              For clubs & academies
            </p>
            <h2 className="text-[clamp(26px,4.5vw,48px)] font-semibold tracking-[-0.02em] leading-[1.05] text-timberwolf mb-4">
              Your recordings, your platform.
            </h2>
            <p className="text-ink-muted leading-[1.55] mb-8 max-w-[52ch]">
              Connect your Veo or Spiideo recordings, manage academy
              subscriptions, and give every player instant access to their match
              footage - with the revenue flowing back to you.
            </p>
            <Link
              href="https://playbacksports.ai/#contact"
              target="_blank"
              rel="noopener noreferrer"
              className="group inline-flex items-center justify-center gap-2 h-12 px-6 rounded-full border border-line-strong text-timberwolf text-[15px] transition-colors hover:bg-[rgba(214,213,201,0.04)] hover:border-timberwolf/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-timberwolf focus-visible:ring-offset-2 focus-visible:ring-offset-night"
            >
              Talk to the team
              <ArrowRight
                className="h-4 w-4 transition-transform duration-300 motion-reduce:transition-none group-hover:translate-x-0.5"
                aria-hidden
              />
            </Link>
          </FadeIn>
        </div>
      </section>
    </div>
  )
}
