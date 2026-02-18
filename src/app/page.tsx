'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@braintwopoint0/playback-commons/ui'
import {
  ArrowRight,
  Play,
  Smartphone,
  CreditCard,
  ShieldCheck,
  Zap,
  MonitorPlay,
} from 'lucide-react'
import { Gotcha } from 'gotcha-feedback'
import { FadeIn } from '@/components/FadeIn'

/* ── Animated counter ── */
function CountUp({ target, suffix = '' }: { target: number; suffix?: string }) {
  const [count, setCount] = useState(0)
  const ref = useRef<HTMLSpanElement>(null)
  const started = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return

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
  }, [target])

  return (
    <span ref={ref}>
      {count}
      {suffix}
    </span>
  )
}

/* ── Data ── */
const stats = [
  { value: 500, suffix: '+', label: 'Recordings' },
  { value: 50, suffix: '+', label: 'Venues' },
  { value: 4, suffix: 'K', label: 'Resolution' },
  { value: 24, suffix: '/7', label: 'Access' },
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
    icon: CreditCard,
    title: 'Pay Once',
    desc: 'One-time purchase. No subscriptions, no hidden fees, ever.',
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
    title: 'Purchase access',
    desc: 'One-time payment. Secure checkout powered by Stripe.',
  },
  {
    num: '03',
    title: 'Watch instantly',
    desc: 'Stream in HD from any device. Your purchase is saved forever.',
  },
]

/* ── Page ── */
export default function HomePage() {
  return (
    <div className="bg-[var(--night)] overflow-hidden">
      {/* ═══ HERO ═══ */}
      <section className="relative min-h-[90vh] flex items-center">
        {/* Ambient background */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute -top-[20%] -right-[15%] w-[700px] h-[700px] rounded-full bg-[var(--timberwolf)]/[0.04] blur-[160px]" />
          <div className="absolute -bottom-[15%] -left-[10%] w-[500px] h-[500px] rounded-full bg-[var(--ash-grey)]/[0.03] blur-[120px]" />
          <div
            className="absolute inset-0 opacity-[0.03]"
            style={{
              backgroundImage:
                'linear-gradient(var(--ash-grey) 1px, transparent 1px), linear-gradient(90deg, var(--ash-grey) 1px, transparent 1px)',
              backgroundSize: '80px 80px',
            }}
          />
        </div>

        <div className="container mx-auto px-5 relative z-10 py-20">
          <FadeIn delay={150}>
            <p className="text-[var(--ash-grey)] text-xs md:text-sm font-semibold tracking-[0.25em] uppercase mb-6">
              Match Recording Marketplace
            </p>
          </FadeIn>

          <FadeIn delay={250}>
            <h1 className="text-[2.75rem] leading-[0.92] md:text-7xl lg:text-[5.5rem] font-extrabold tracking-tight mb-8">
              <span className="text-[var(--timberwolf)] block">YOUR GAME.</span>
              <span className="block bg-gradient-to-r from-[var(--timberwolf)] to-[var(--ash-grey)] bg-clip-text text-transparent">
                ON DEMAND.
              </span>
            </h1>
          </FadeIn>

          <FadeIn delay={450}>
            <p className="text-base md:text-lg text-[var(--ash-grey)] max-w-md mb-10 leading-relaxed">
              Full match recordings from clubs and academies.
              <br className="hidden sm:block" /> Pay once, watch forever. No
              subscriptions, no ads.
            </p>
          </FadeIn>

          <FadeIn delay={600} className="flex flex-col sm:flex-row gap-3">
            <Link href="/recordings">
              <Button
                size="lg"
                className="w-full sm:w-auto bg-[var(--timberwolf)] text-[var(--night)] hover:bg-[var(--ash-grey)] font-bold px-8 text-base"
              >
                Browse Matches
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
            <Link href="/auth/register">
              <Button
                size="lg"
                variant="outline"
                className="w-full sm:w-auto border-[var(--timberwolf)]/20 text-[var(--timberwolf)] hover:bg-[var(--timberwolf)]/5 px-8 text-base"
              >
                Create Account
              </Button>
            </Link>
          </FadeIn>
        </div>
      </section>

      {/* ═══ STATS ═══ */}
      <section className="bg-white/[0.03]">
        <div className="container mx-auto px-5 py-14 md:py-20">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8 md:gap-0">
            {stats.map((stat, i) => (
              <FadeIn
                key={stat.label}
                delay={i * 100}
                className={`text-center ${
                  i < stats.length - 1
                    ? 'md:border-r md:border-[var(--ash-grey)]/10'
                    : ''
                }`}
              >
                <p className="text-3xl md:text-5xl font-extrabold text-[var(--timberwolf)] mb-1">
                  <CountUp target={stat.value} suffix={stat.suffix} />
                </p>
                <p className="text-xs md:text-sm text-[var(--ash-grey)]">
                  {stat.label}
                </p>
              </FadeIn>
            ))}
          </div>
        </div>
      </section>

      {/* ═══ FEATURES ═══ */}
      <section>
        <div className="container mx-auto px-5 py-20 md:py-28">
          <FadeIn className="mb-12 md:mb-16">
            <p className="text-[var(--ash-grey)] text-xs font-semibold tracking-[0.25em] uppercase mb-3">
              Why PLAYHUB
            </p>
            <h2 className="text-2xl md:text-4xl font-bold text-[var(--timberwolf)]">
              Everything you need to
              <br className="hidden md:block" /> watch the beautiful game.
            </h2>
          </FadeIn>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-5">
            {features.map((f, i) => (
              <FadeIn
                key={f.title}
                delay={i * 70}
                className="group p-6 rounded-xl border border-[var(--ash-grey)]/10 hover:border-[var(--timberwolf)]/25 bg-white/[0.015] hover:bg-white/[0.035] transition-colors duration-300"
              >
                <f.icon className="w-5 h-5 text-[var(--timberwolf)] mb-4 transition-transform duration-300 group-hover:scale-110" />
                <h3 className="text-[var(--timberwolf)] font-semibold mb-2">
                  {f.title}
                </h3>
                <p className="text-sm text-[var(--ash-grey)] leading-relaxed">
                  {f.desc}
                </p>
              </FadeIn>
            ))}
          </div>
        </div>
      </section>

      {/* ═══ HOW IT WORKS ═══ */}
      <section className="bg-white/[0.03]">
        <div className="container mx-auto px-5 py-20 md:py-28">
          <FadeIn className="mb-12 md:mb-16">
            <p className="text-[var(--ash-grey)] text-xs font-semibold tracking-[0.25em] uppercase mb-3">
              Simple process
            </p>
            <h2 className="text-2xl md:text-4xl font-bold text-[var(--timberwolf)]">
              Three steps to kickoff.
            </h2>
          </FadeIn>

          <div className="grid md:grid-cols-3 gap-10 md:gap-12">
            {steps.map((step, i) => (
              <FadeIn
                key={step.num}
                delay={i * 150}
                className="relative pl-5 border-l-2 border-[var(--timberwolf)]/20"
              >
                <span className="text-[var(--ash-grey)] text-xs font-bold tracking-widest mb-3 block">
                  STEP {step.num}
                </span>
                <h3 className="text-lg font-semibold text-[var(--timberwolf)] mb-2">
                  {step.title}
                </h3>
                <p className="text-sm text-[var(--ash-grey)] leading-relaxed">
                  {step.desc}
                </p>
              </FadeIn>
            ))}
          </div>
        </div>
      </section>

      {/* ═══ FOR CLUBS ═══ */}
      <section>
        <div className="container mx-auto px-5 py-20 md:py-28">
          <FadeIn direction="left" className="max-w-2xl">
            <p className="text-[var(--ash-grey)] text-xs font-semibold tracking-[0.25em] uppercase mb-4">
              For clubs & academies
            </p>
            <h2 className="text-2xl md:text-4xl font-bold text-[var(--timberwolf)] mb-4 leading-tight">
              Monetize your
              <br />
              match recordings.
            </h2>
            <p className="text-[var(--ash-grey)] leading-relaxed mb-8 max-w-lg">
              Already recording your matches? Upload them to PLAYHUB and earn
              revenue from fans, parents, and scouts who want to watch.
            </p>
            <Link href="https://playbacksports.ai">
              <Button
                variant="outline"
                size="lg"
                className="border-[var(--timberwolf)]/30 text-[var(--timberwolf)] hover:bg-[var(--timberwolf)]/10"
              >
                Get in touch
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
          </FadeIn>
        </div>
      </section>
    </div>
  )
}
