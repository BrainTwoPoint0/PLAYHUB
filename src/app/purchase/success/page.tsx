import Link from 'next/link'
import { Button } from '@braintwopoint0/playback-commons/ui'

export default async function PurchaseSuccessPage({
  searchParams,
}: {
  searchParams: Promise<{ session_id?: string }>
}) {
  const resolvedSearchParams = await searchParams
  return (
    <div className="min-h-screen bg-[var(--night)] flex items-center justify-center px-5">
      <div className="max-w-2xl w-full text-center">
        {/* Success Icon */}
        <div className="w-32 h-32 mx-auto mb-8 rounded-full bg-gradient-to-r from-[var(--accent-green)] to-[var(--accent-blue)] flex items-center justify-center shadow-2xl shadow-green-500/30">
          <span className="text-7xl text-white">✓</span>
        </div>

        {/* Success Message */}
        <h1 className="text-5xl font-bold text-[var(--timberwolf)] mb-4">
          Purchase Complete!
        </h1>
        <p className="text-xl text-[var(--ash-grey)] mb-8">
          Thank you for your purchase. You now have lifetime access to this
          match.
        </p>

        {/* Session ID */}
        {resolvedSearchParams.session_id && (
          <div className="mb-8 p-4 bg-black/20 border border-[var(--ash-grey)]/10 rounded-xl">
            <p className="text-sm text-[var(--ash-grey)]/60 mb-1">Order ID</p>
            <p className="text-sm text-[var(--ash-grey)] font-mono">
              {resolvedSearchParams.session_id}
            </p>
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex flex-col sm:flex-row gap-4 justify-center mb-12">
          <Button
            size="lg"
            className="bg-gradient-to-r from-[var(--accent-purple)] to-[var(--accent-blue)] text-white hover:opacity-90 font-semibold px-8 py-6 text-lg rounded-xl shadow-lg shadow-purple-500/30"
            asChild
          >
            <Link href="/matches">Browse More Matches</Link>
          </Button>
          <Button
            size="lg"
            variant="outline"
            className="border-2 border-[var(--ash-grey)]/30 text-[var(--timberwolf)] hover:bg-[var(--ash-grey)]/10 font-semibold px-8 py-6 text-lg rounded-xl"
            asChild
          >
            <Link href="/">Go Home</Link>
          </Button>
        </div>

        {/* Info Box */}
        <div className="p-6 bg-black/20 border border-[var(--ash-grey)]/10 rounded-2xl">
          <p className="text-[var(--ash-grey)]/80 text-sm">
            A confirmation email has been sent to your email address. You can
            now watch your purchased match anytime from your library.
          </p>
        </div>
      </div>
    </div>
  )
}
