import Link from 'next/link'
import { Button } from '@braintwopoint0/playback-commons/ui'
import { CheckCircle } from 'lucide-react'

export default async function PurchaseSuccessPage({
  searchParams,
}: {
  searchParams: Promise<{ session_id?: string }>
}) {
  const resolvedSearchParams = await searchParams
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

        {resolvedSearchParams.session_id && (
          <div className="rounded-lg border border-border bg-card p-3">
            <p className="text-xs text-muted-foreground mb-1">Order ID</p>
            <p className="text-xs text-[var(--timberwolf)] font-mono truncate">
              {resolvedSearchParams.session_id}
            </p>
          </div>
        )}

        <div className="flex flex-col gap-3 pt-2">
          <Button asChild>
            <Link href="/matches">Browse More Matches</Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href="/">Go Home</Link>
          </Button>
        </div>

        <p className="text-xs text-muted-foreground">
          A confirmation email has been sent to your email address. You can
          now watch your purchased match anytime from your library.
        </p>
      </div>
    </div>
  )
}
