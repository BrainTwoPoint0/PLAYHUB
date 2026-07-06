'use client'

import { Link } from '@/i18n/navigation'
import { useTranslations } from 'next-intl'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@braintwopoint0/playback-commons/ui'
import {
  ArrowRight,
  Play,
  Smartphone,
  CalendarCheck,
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

/* ── Static data (labels resolved inside the component via t()) ── */
const STAT_DEFS = [
  { key: 'recordings', value: 1000, suffix: '+' },
  { key: 'venues', value: 50, suffix: '+' },
  { key: 'resolution', value: 4, suffix: 'K' },
  { key: 'access', value: 24, suffix: '/7' },
] as const

const FEATURE_DEFS = [
  { key: 'streaming', icon: MonitorPlay },
  { key: 'instant', icon: Zap },
  { key: 'device', icon: Smartphone },
  { key: 'academy', icon: CalendarCheck },
  { key: 'payments', icon: ShieldCheck },
  { key: 'library', icon: Play },
] as const

const STEP_DEFS = [
  { key: 'find', num: '01' },
  { key: 'access', num: '02' },
  { key: 'watch', num: '03' },
] as const

/* ── Page ── */
export default function HomePage() {
  const t = useTranslations('landing')
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
              {t('eyebrow')}
            </p>
          </FadeIn>

          <FadeIn delay={250}>
            <h1 className="text-[2.75rem] leading-[0.92] rtl:leading-[1.25] md:text-7xl lg:text-[5.5rem] font-extrabold tracking-tight rtl:tracking-normal mb-8">
              <span className="text-[var(--timberwolf)] block">
                {t('heroTitle1')}
              </span>
              <span className="block bg-gradient-to-r rtl:bg-gradient-to-l from-[var(--timberwolf)] to-[var(--ash-grey)] bg-clip-text text-transparent">
                {t('heroTitle2')}
              </span>
            </h1>
          </FadeIn>

          <FadeIn delay={450}>
            <p className="text-base md:text-lg text-[var(--ash-grey)] max-w-md mb-10 leading-relaxed">
              {t('heroDescription')}
            </p>
          </FadeIn>

          <FadeIn delay={600}>
            <Link href="/recordings">
              <Button
                size="lg"
                className="w-full sm:w-auto bg-[var(--timberwolf)] text-[var(--night)] hover:bg-[var(--ash-grey)] font-bold px-8 text-base"
              >
                {t('browseRecordings')}
                <ArrowRight className="ms-2 h-4 w-4 rtl:rotate-180" />
              </Button>
            </Link>
          </FadeIn>
        </div>
      </section>

      {/* ═══ STATS ═══ */}
      <section className="bg-white/[0.03]">
        <div className="container mx-auto px-5 py-14 md:py-20">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8 md:gap-0">
            {STAT_DEFS.map((stat, i) => (
              <FadeIn
                key={stat.key}
                delay={i * 100}
                className={`text-center ${
                  i < STAT_DEFS.length - 1
                    ? 'md:border-e md:border-[var(--ash-grey)]/10'
                    : ''
                }`}
              >
                <p
                  dir="ltr"
                  className="text-3xl md:text-5xl font-extrabold text-[var(--timberwolf)] mb-1"
                >
                  <CountUp target={stat.value} suffix={stat.suffix} />
                </p>
                <p className="text-xs md:text-sm text-[var(--ash-grey)]">
                  {t(`stats.${stat.key}`)}
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
              {t('whyEyebrow')}
            </p>
            <h2 className="text-2xl md:text-4xl font-bold text-[var(--timberwolf)]">
              {t('whyTitle1')}
              <br className="hidden md:block" /> {t('whyTitle2')}
            </h2>
          </FadeIn>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-5">
            {FEATURE_DEFS.map((f, i) => (
              <FadeIn
                key={f.key}
                delay={i * 70}
                className="group p-6 rounded-xl border border-[var(--ash-grey)]/10 hover:border-[var(--timberwolf)]/25 bg-white/[0.015] hover:bg-white/[0.035] transition-colors duration-300"
              >
                <f.icon className="w-5 h-5 text-[var(--timberwolf)] mb-4 transition-transform duration-300 group-hover:scale-110" />
                <h3 className="text-[var(--timberwolf)] font-semibold mb-2">
                  {t(`features.${f.key}.title`)}
                </h3>
                <p className="text-sm text-[var(--ash-grey)] leading-relaxed">
                  {t(`features.${f.key}.desc`)}
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
              {t('processEyebrow')}
            </p>
            <h2 className="text-2xl md:text-4xl font-bold text-[var(--timberwolf)]">
              {t('processTitle')}
            </h2>
          </FadeIn>

          <div className="grid md:grid-cols-3 gap-10 md:gap-12">
            {STEP_DEFS.map((step, i) => (
              <FadeIn
                key={step.num}
                delay={i * 150}
                className="relative ps-5 border-s-2 border-[var(--timberwolf)]/20"
              >
                <span className="text-[var(--ash-grey)] text-xs font-bold tracking-widest mb-3 block">
                  {t('stepLabel', { num: step.num })}
                </span>
                <h3 className="text-lg font-semibold text-[var(--timberwolf)] mb-2">
                  {t(`steps.${step.key}.title`)}
                </h3>
                <p className="text-sm text-[var(--ash-grey)] leading-relaxed">
                  {t(`steps.${step.key}.desc`)}
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
              {t('clubsEyebrow')}
            </p>
            <h2 className="text-2xl md:text-4xl font-bold text-[var(--timberwolf)] mb-4 leading-tight">
              {t('clubsTitle1')}
              <br />
              {t('clubsTitle2')}
            </h2>
            <p className="text-[var(--ash-grey)] leading-relaxed mb-8 max-w-lg">
              {t('clubsDescription')}
            </p>
            <a href="https://playbacksports.ai">
              <Button
                variant="outline"
                size="lg"
                className="border-[var(--timberwolf)]/30 text-[var(--timberwolf)] hover:bg-[var(--timberwolf)]/10"
              >
                {t('getInTouch')}
                <ArrowRight className="ms-2 h-4 w-4 rtl:rotate-180" />
              </Button>
            </a>
          </FadeIn>
        </div>
      </section>
    </div>
  )
}
