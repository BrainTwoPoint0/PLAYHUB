import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Terms of Service — PLAYHUB',
  description:
    'PLAYHUB marketplace terms covering purchases, academy subscriptions, and content uploaded by clubs.',
}

export default function TermsPage() {
  return (
    <article className="text-[rgba(214,213,201,0.72)]">
      <p className="text-[11px] uppercase tracking-[0.22em] font-semibold text-[rgba(214,213,201,0.44)] mb-4">
        Legal
      </p>
      <h1 className="font-semibold text-[clamp(32px,4vw,56px)] leading-[1.05] tracking-[-0.035em] text-[var(--timberwolf)] mb-2">
        PLAYHUB Terms of Service
      </h1>
      <p className="text-[13px] text-[rgba(214,213,201,0.44)] mb-12">
        Last updated: April 2026
      </p>

      <section className="space-y-6 text-[15px] leading-[1.65]">
        <p>
          These Terms govern your use of{' '}
          <strong className="text-[var(--timberwolf)]">PLAYHUB</strong> — the
          marketplace and academy-subscription service operated at
          playhub.playbacksports.ai (the &ldquo;Service&rdquo;). The Service is
          operated by{' '}
          <strong className="text-[var(--timberwolf)]">
            PLAYBACK Sports Ltd
          </strong>{' '}
          (company number 15638660), a company registered in England and Wales
          with registered office at 71-75 Shelton Street, Covent Garden, London,
          WC2H 9JQ (&ldquo;PLAYBACK&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;).
          These Terms supplement the{' '}
          <a
            href="https://playbacksports.ai/legal/terms"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--timberwolf)] underline underline-offset-4 hover:opacity-80"
          >
            PLAYBACK master Terms of Service
          </a>
          . Where there is a conflict between the two on matters specific to
          PLAYHUB, these Terms prevail.
        </p>

        <div>
          <h2 className="font-medium text-[var(--timberwolf)] text-[20px] mt-10 mb-3">
            Accounts
          </h2>
          <p>
            You need an account to purchase content, subscribe to an academy
            programme, or access purchased recordings. You are responsible for
            activity under your account and for keeping your credentials secure.
            One account per person — do not share access or resell your
            credentials.
          </p>
        </div>

        <div>
          <h2 className="font-medium text-[var(--timberwolf)] text-[20px] mt-10 mb-3">
            Purchases and subscriptions
          </h2>
          <p>
            Payments are processed by Stripe under Stripe&rsquo;s terms. Prices
            are displayed in the currency shown at checkout and are inclusive of
            any applicable taxes unless stated otherwise. Academy subscriptions
            renew automatically until cancelled; you can cancel any time from
            the Stripe customer portal and access continues until the end of the
            current billing period.
          </p>
          <p className="mt-3">
            One-off purchases (match recordings, highlight packs) grant access
            according to the access terms stated on the product page — lifetime,
            time-limited, or for the duration of an active academy subscription.
          </p>
        </div>

        <div>
          <h2 className="font-medium text-[var(--timberwolf)] text-[20px] mt-10 mb-3">
            Refunds
          </h2>
          <p>Refund policy depends on the product:</p>
          <ul className="mt-3 space-y-2 list-disc pl-5">
            <li>
              <strong className="text-[var(--timberwolf)]">
                One-off purchases:
              </strong>{' '}
              because digital content is delivered immediately on purchase, you
              waive your statutory right of withdrawal once playback has
              started. Pre-playback refunds are available within 14 days.
            </li>
            <li>
              <strong className="text-[var(--timberwolf)]">
                Academy subscriptions:
              </strong>{' '}
              subscription fees are non-refundable once the billing period has
              started. Cancel before the next renewal to stop further charges.
            </li>
            <li>
              <strong className="text-[var(--timberwolf)]">
                Technical failure:
              </strong>{' '}
              if a recording is missing, unplayable, or materially different
              from what was advertised, contact support and we will refund or
              replace it.
            </li>
          </ul>
          <p className="mt-3">
            Refund requests: email{' '}
            <a
              href="mailto:admin@playbacksports.ai"
              className="text-[var(--timberwolf)] underline underline-offset-4 hover:opacity-80"
            >
              admin@playbacksports.ai
            </a>{' '}
            with your order reference.
          </p>
        </div>

        <div>
          <h2 className="font-medium text-[var(--timberwolf)] text-[20px] mt-10 mb-3">
            Content uploaded by clubs and academies
          </h2>
          <p>
            Organisations listing match recordings or academy content on PLAYHUB
            retain ownership of that content. By listing content, the
            organisation represents that it has the right to sell or distribute
            it — including rights from players, parents, and any third-party
            recording provider (Veo, Spiideo, Pixellot). Organisations grant
            PLAYBACK a worldwide, royalty-free licence to host, transcode,
            cache, and deliver that content to paying users for the duration of
            the listing and any active access grants.
          </p>
          <p className="mt-3">
            Revenue share, payout cadence, and content exclusivity are governed
            by the bilateral partnership agreement between PLAYBACK and the
            organisation, not these Terms.
          </p>
        </div>

        <div>
          <h2 className="font-medium text-[var(--timberwolf)] text-[20px] mt-10 mb-3">
            Acceptable use
          </h2>
          <p>
            You must not download, screen-record, redistribute, or resell
            purchased content. You must not attempt to bypass access controls,
            rate limits, or authentication on the Service. You must not upload
            content that infringes third-party rights or that was captured
            without the consent of the people in it.
          </p>
        </div>

        <div>
          <h2 className="font-medium text-[var(--timberwolf)] text-[20px] mt-10 mb-3">
            Takedown and content removal
          </h2>
          <p>
            If you believe content on PLAYHUB infringes your rights or was
            uploaded without appropriate consent, contact{' '}
            <a
              href="mailto:admin@playbacksports.ai"
              className="text-[var(--timberwolf)] underline underline-offset-4 hover:opacity-80"
            >
              admin@playbacksports.ai
            </a>{' '}
            with details of the content and the basis of your claim. We respond
            to valid requests promptly and may remove content pending
            investigation.
          </p>
        </div>

        <div>
          <h2 className="font-medium text-[var(--timberwolf)] text-[20px] mt-10 mb-3">
            Service availability
          </h2>
          <p>
            We aim for high availability but do not guarantee uninterrupted
            access. Scheduled maintenance, third-party provider outages (Stripe,
            Supabase, video-hosting providers), and force majeure events can
            cause temporary unavailability. Extended outages that materially
            affect access to paid content are handled under the Refunds section
            above.
          </p>
        </div>

        <div>
          <h2 className="font-medium text-[var(--timberwolf)] text-[20px] mt-10 mb-3">
            Limitation of liability
          </h2>
          <p>
            To the maximum extent permitted by law, PLAYBACK&rsquo;s aggregate
            liability under these Terms is limited to the amount you have paid
            to PLAYHUB in the 12 months preceding the claim. Nothing in these
            Terms limits liability for death or personal injury caused by
            negligence, fraud, or any other liability that cannot lawfully be
            limited.
          </p>
        </div>

        <div>
          <h2 className="font-medium text-[var(--timberwolf)] text-[20px] mt-10 mb-3">
            Privacy and cookies
          </h2>
          <p>
            PLAYHUB uses the same authentication, data stores, and analytics as
            the wider PLAYBACK platform. How we handle your personal data is
            described in the{' '}
            <a
              href="https://playbacksports.ai/legal/privacy"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--timberwolf)] underline underline-offset-4 hover:opacity-80"
            >
              PLAYBACK Privacy Policy
            </a>
            . Cookie usage is described in the{' '}
            <a
              href="https://playbacksports.ai/legal/cookies"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--timberwolf)] underline underline-offset-4 hover:opacity-80"
            >
              PLAYBACK Cookie Policy
            </a>
            .
          </p>
        </div>

        <div>
          <h2 className="font-medium text-[var(--timberwolf)] text-[20px] mt-10 mb-3">
            Changes to these Terms
          </h2>
          <p>
            We may update these Terms from time to time. Material changes —
            particularly to pricing, refunds, or content licensing — will be
            notified by email or on-platform before taking effect. Continued use
            of the Service after changes take effect constitutes acceptance.
          </p>
        </div>

        <div>
          <h2 className="font-medium text-[var(--timberwolf)] text-[20px] mt-10 mb-3">
            Governing law
          </h2>
          <p>
            These Terms are governed by the laws of England and Wales. Disputes
            are subject to the exclusive jurisdiction of the English courts,
            except where non-waivable consumer-protection laws in your place of
            residence apply.
          </p>
        </div>

        <div>
          <h2 className="font-medium text-[var(--timberwolf)] text-[20px] mt-10 mb-3">
            Contact
          </h2>
          <p>
            Questions about these Terms:{' '}
            <a
              href="mailto:admin@playbacksports.ai"
              className="text-[var(--timberwolf)] underline underline-offset-4 hover:opacity-80"
            >
              admin@playbacksports.ai
            </a>
            .
          </p>
        </div>

        <p className="text-[13px] text-[rgba(214,213,201,0.44)] mt-12">
          Back to{' '}
          <Link
            href="/"
            className="text-[var(--timberwolf)] underline underline-offset-4 hover:opacity-80"
          >
            PLAYHUB home
          </Link>
          .
        </p>
      </section>
    </article>
  )
}
