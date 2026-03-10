import Link from 'next/link'
import { Button } from '@braintwopoint0/playback-commons/ui'
import { CheckCircle, AlertCircle } from 'lucide-react'
import Stripe from 'stripe'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-02-24.acacia',
})

export default async function PurchaseSuccessPage({
  searchParams,
}: {
  searchParams: Promise<{ session_id?: string }>
}) {
  const resolvedSearchParams = await searchParams
  const sessionId = resolvedSearchParams.session_id

  // Verify payment with Stripe
  let verified = false
  let matchRecordingId: string | null = null
  if (sessionId) {
    try {
      const session = await stripe.checkout.sessions.retrieve(sessionId)
      verified = session.payment_status === 'paid'
      matchRecordingId = session.metadata?.match_recording_id || null
    } catch {
      // Invalid or expired session
    }
  }

  if (!verified) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="max-w-md w-full text-center space-y-6">
          <div className="w-16 h-16 mx-auto rounded-full border border-yellow-400/30 bg-yellow-400/[0.06] flex items-center justify-center">
            <AlertCircle className="h-8 w-8 text-yellow-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-[var(--timberwolf)] mb-2">
              Payment Processing
            </h1>
            <p className="text-sm text-muted-foreground">
              Your payment is being processed. If you completed the checkout,
              your access will be granted shortly.
            </p>
          </div>
          <div className="flex flex-col gap-3 pt-2">
            <Button asChild>
              <Link href="/matches">Browse Matches</Link>
            </Button>
            <Button variant="outline" asChild>
              <Link href="/">Go Home</Link>
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="max-w-md w-full text-center space-y-6">
        <div className="w-16 h-16 mx-auto rounded-full border border-emerald-400/30 bg-emerald-400/[0.06] flex items-center justify-center">
          <CheckCircle className="h-8 w-8 text-emerald-400" />
        </div>

        <div>
          <h1 className="text-2xl font-bold text-[var(--timberwolf)] mb-2">
            Purchase Complete
          </h1>
          <p className="text-sm text-muted-foreground">
            Thank you for your purchase. You now have lifetime access to this
            match.
          </p>
        </div>

        <div className="flex flex-col gap-3 pt-2">
          {matchRecordingId && (
            <Button asChild>
              <Link href={`/matches/${matchRecordingId}`}>Watch Now</Link>
            </Button>
          )}
          <Button variant={matchRecordingId ? 'outline' : 'default'} asChild>
            <Link href="/matches">Browse More Matches</Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href="/">Go Home</Link>
          </Button>
        </div>

        <p className="text-xs text-muted-foreground">
          A confirmation email has been sent to your email address. You can now
          watch your purchased match anytime from your library.
        </p>
      </div>
    </div>
  )
}
