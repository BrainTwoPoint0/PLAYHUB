'use client'

import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { ArrowRight } from 'lucide-react'
import { Gotcha } from 'gotcha-feedback'

export default function HomePage() {
  return (
    <div className="bg-[var(--night)]">
      {/* Hero */}
      <section className="container mx-auto px-5 pt-20 pb-32">
        <div className="max-w-3xl">
          <p className="text-[var(--ash-grey)] mb-4 text-sm tracking-wide uppercase">
            Match Recording Marketplace
          </p>
          <h1 className="text-4xl md:text-6xl font-bold text-[var(--timberwolf)] leading-tight mb-6">
            Watch any match,
            <br />
            anytime you want.
          </h1>
          <p className="text-lg text-[var(--ash-grey)] mb-8 max-w-xl leading-relaxed">
            Full match recordings from clubs and academies. Pay once, watch
            forever. No subscriptions, no ads.
          </p>
          <div className="flex gap-4">
            <Link href="/recordings">
              <Button
                size="lg"
                className="bg-[var(--timberwolf)] text-[var(--night)] hover:bg-[var(--ash-grey)]"
              >
                Browse Matches
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* How it works - kept simple */}
      <section className="border-t border-[var(--ash-grey)]/10">
        <div className="container mx-auto px-5 py-20">
          <h2 className="text-2xl font-semibold text-[var(--timberwolf)] mb-12">
            How it works
          </h2>
          <div className="grid md:grid-cols-3 gap-12">
            <div>
              <div className="text-[var(--ash-grey)] text-sm mb-2">01</div>
              <h3 className="text-[var(--timberwolf)] font-medium mb-2">
                Find a match
              </h3>
              <p className="text-[var(--ash-grey)] text-sm leading-relaxed">
                Browse recordings by date, team, or competition. Filter to find
                exactly what you&apos;re looking for.
              </p>
            </div>
            <div>
              <div className="text-[var(--ash-grey)] text-sm mb-2">02</div>
              <h3 className="text-[var(--timberwolf)] font-medium mb-2">
                Purchase access
              </h3>
              <p className="text-[var(--ash-grey)] text-sm leading-relaxed">
                One-time payment. No subscription required. Secure checkout via
                Stripe.
              </p>
            </div>
            <div>
              <div className="text-[var(--ash-grey)] text-sm mb-2">03</div>
              <h3 className="text-[var(--timberwolf)] font-medium mb-2">
                Watch instantly
              </h3>
              <p className="text-[var(--ash-grey)] text-sm leading-relaxed">
                Stream in HD from any device. Your purchases are saved to your
                library forever.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* For organizations */}
      <section className="border-t border-[var(--ash-grey)]/10">
        <div className="container mx-auto px-5 py-20">
          <div className="max-w-xl">
            <p className="text-[var(--ash-grey)] text-sm mb-3">
              For clubs & academies
            </p>
            <h2 className="text-2xl font-semibold text-[var(--timberwolf)] mb-4">
              Monetize your match recordings
            </h2>
            <p className="text-[var(--ash-grey)] leading-relaxed mb-6">
              Already recording your matches? Upload them to PLAYHUB and earn
              revenue from fans, parents, and scouts who want to watch.
            </p>
            <Link
              href="https://playbacksports.ai"
              className="text-[var(--timberwolf)] text-sm hover:underline"
            >
              Get in touch →
            </Link>
          </div>
        </div>
      </section>

      {/* Feedback Section */}
      <section className="border-t border-[var(--ash-grey)]/10">
        <div className="container mx-auto px-5 py-12">
          <div className="flex items-center justify-center gap-4">
            <span className="text-[var(--ash-grey)] text-sm">
              How do you like PLAYHUB so far?
            </span>
            <Gotcha
              elementId="homepage-feedback"
              mode="vote"
              position="inline"
              theme="dark"
              showOnHover={false}
            />
          </div>
        </div>
      </section>
    </div>
  )
}
