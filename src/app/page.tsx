'use client'

import Link from 'next/link'
import { motion } from 'motion/react'
import { Button } from '@/components/ui/button'

export default function HomePage() {
  return (
    <div className="min-h-screen bg-[var(--night)]">
      {/* Clean Hero Section */}
      <section className="relative overflow-hidden bg-[var(--night)]">
        <div className="absolute inset-0 bg-[linear-gradient(to_right,#4f4f4f0a_1px,transparent_1px),linear-gradient(to_bottom,#4f4f4f0a_1px,transparent_1px)] bg-[size:4rem_4rem]" />

        <div className="container relative mx-auto px-5 py-32 md:py-40">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            className="max-w-4xl mx-auto text-center"
          >
            <div className="inline-block mb-6 px-4 py-2 bg-black/30 border border-[var(--ash-grey)]/20 rounded-full text-sm text-[var(--ash-grey)]">
              🎬 The Match Recording Marketplace
            </div>

            <h1 className="text-5xl md:text-7xl font-bold mb-6 leading-tight">
              <span className="bg-clip-text text-transparent bg-gradient-to-r from-[var(--accent-purple)] via-[var(--accent-blue)] to-[var(--accent-green)]">
                Buy & Watch
              </span>
              <br />
              <span className="text-[var(--timberwolf)]">
                Professional Matches
              </span>
            </h1>

            <p className="text-xl md:text-2xl text-zinc-400 mb-10 max-w-2xl mx-auto leading-relaxed">
              Stream full match recordings from clubs and academies worldwide.
              Instant access, HD quality, lifetime ownership.
            </p>

            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <Link href="/matches">
                <Button
                  size="lg"
                  className="w-full sm:w-auto bg-gradient-to-r from-[var(--accent-purple)] to-[var(--accent-blue)] text-white hover:opacity-90 font-semibold px-8 py-6 text-lg rounded-xl shadow-lg shadow-purple-500/30"
                >
                  Browse Marketplace
                </Button>
              </Link>
              <Link href="/auth/register">
                <Button
                  size="lg"
                  variant="outline"
                  className="w-full sm:w-auto border-2 border-[var(--accent-purple)]/50 text-[var(--timberwolf)] hover:bg-[var(--accent-purple)]/10 hover:border-[var(--accent-purple)] font-semibold px-8 py-6 text-lg rounded-xl"
                >
                  Create Account
                </Button>
              </Link>
            </div>

            {/* Stats */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.3 }}
              className="mt-16 flex flex-wrap items-center justify-center gap-12"
            >
              <div className="text-center">
                <div className="text-3xl font-bold text-[var(--accent-purple)]">
                  500+
                </div>
                <div className="text-sm text-[var(--ash-grey)]/60 mt-1">
                  Match Recordings
                </div>
              </div>
              <div className="text-center">
                <div className="text-3xl font-bold text-[var(--accent-blue)]">
                  50+
                </div>
                <div className="text-sm text-[var(--ash-grey)]/60 mt-1">
                  Sports Organizations
                </div>
              </div>
              <div className="text-center">
                <div className="text-3xl font-bold text-[var(--accent-green)]">
                  HD
                </div>
                <div className="text-sm text-[var(--ash-grey)]/60 mt-1">
                  Quality Streaming
                </div>
              </div>
            </motion.div>
          </motion.div>
        </div>
      </section>

      {/* How it Works - Simple Cards */}
      <section className="py-24 bg-[var(--night)]">
        <div className="container mx-auto px-5">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-center mb-16"
          >
            <h2 className="text-4xl md:text-5xl font-bold text-[var(--timberwolf)] mb-4">
              Simple. Fast. Secure.
            </h2>
            <p className="text-xl text-[var(--ash-grey)]">
              Three steps to watch any match
            </p>
          </motion.div>

          <div className="grid md:grid-cols-3 gap-8 max-w-5xl mx-auto">
            {[
              {
                num: '1',
                title: 'Find Your Match',
                desc: 'Browse our marketplace of professional recordings',
                icon: '🔍',
                color: 'var(--accent-purple)',
              },
              {
                num: '2',
                title: 'Secure Payment',
                desc: 'One-time payment, instant access to your content',
                icon: '💳',
                color: 'var(--accent-blue)',
              },
              {
                num: '3',
                title: 'Watch Forever',
                desc: 'Stream anytime in HD. No ads, no limits',
                icon: '▶️',
                color: 'var(--accent-green)',
              },
            ].map((step, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.1 }}
                className="relative group"
              >
                <div
                  className="absolute inset-0 rounded-2xl blur-xl opacity-0 group-hover:opacity-100 transition-opacity"
                  style={{
                    background: `radial-gradient(circle, ${step.color}20 0%, transparent 70%)`,
                  }}
                />
                <div
                  className="relative p-8 bg-black/20 border border-[var(--ash-grey)]/10 rounded-2xl hover:shadow-lg transition-all"
                  style={{ borderColor: `${step.color}40` }}
                >
                  <div className="text-5xl mb-4">{step.icon}</div>
                  <div
                    className="text-sm font-mono mb-2"
                    style={{ color: step.color }}
                  >
                    STEP {step.num}
                  </div>
                  <h3 className="text-2xl font-bold text-[var(--timberwolf)] mb-3">
                    {step.title}
                  </h3>
                  <p className="text-[var(--ash-grey)]/80 leading-relaxed">
                    {step.desc}
                  </p>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-24 bg-[var(--night)]">
        <div className="container mx-auto px-5">
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            whileInView={{ opacity: 1, scale: 1 }}
            viewport={{ once: true }}
            className="max-w-4xl mx-auto text-center p-12 md:p-16 bg-black/20 border border-[var(--ash-grey)]/20 rounded-3xl"
          >
            <h2 className="text-4xl md:text-5xl font-bold text-[var(--timberwolf)] mb-6">
              Ready to Start Watching?
            </h2>
            <p className="text-xl text-[var(--ash-grey)] mb-10 max-w-2xl mx-auto">
              Join thousands of fans accessing exclusive match content
            </p>
            <Link href="/matches">
              <Button
                size="lg"
                className="bg-gradient-to-r from-[var(--accent-purple)] to-[var(--accent-blue)] text-white hover:opacity-90 font-semibold px-10 py-6 text-lg rounded-xl shadow-lg shadow-purple-500/30"
              >
                Explore Marketplace
              </Button>
            </Link>
          </motion.div>
        </div>
      </section>

      {/* For Sellers */}
      <section className="py-24 bg-[var(--night)]">
        <div className="container mx-auto px-5">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="max-w-3xl mx-auto text-center"
          >
            <div className="inline-block mb-6 px-4 py-2 bg-black/30 border border-[var(--ash-grey)]/20 rounded-full text-sm text-[var(--ash-grey)]">
              For Clubs & Academies
            </div>
            <h3 className="text-3xl md:text-4xl font-bold text-[var(--timberwolf)] mb-6">
              Turn Your Matches Into Revenue
            </h3>
            <p className="text-lg text-[var(--ash-grey)] mb-8">
              Upload your recordings, set your price, and reach a global
              audience of fans and scouts.
            </p>
            <Button
              variant="outline"
              className="border-2 border-[var(--accent-orange)]/50 text-[var(--timberwolf)] hover:bg-[var(--accent-orange)]/10 hover:border-[var(--accent-orange)] font-semibold px-8 py-6 text-lg rounded-xl"
            >
              Learn About Selling
            </Button>
          </motion.div>
        </div>
      </section>
    </div>
  )
}
