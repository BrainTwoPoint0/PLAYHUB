'use client'

import { useSearchParams } from 'next/navigation'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  Badge,
} from '@braintwopoint0/playback-commons/ui'

export default function BookingSuccessPage() {
  const searchParams = useSearchParams()
  const sessionId = searchParams.get('session_id')
  const paymentIntentId = searchParams.get('payment_intent')
  const refId = paymentIntentId || sessionId

  return (
    <div className="min-h-[100dvh] bg-[var(--night)] flex items-center justify-center p-6">
      <Card className="max-w-[400px] w-full bg-transparent border-[var(--ash-grey)]/10 text-center">
        <CardHeader className="space-y-4">
          <div className="w-16 h-16 mx-auto rounded-full border border-emerald-400/30 bg-emerald-400/[0.06] flex items-center justify-center">
            <svg
              width="28"
              height="28"
              viewBox="0 0 24 24"
              fill="none"
              className="text-emerald-400"
            >
              <path
                d="M5 13l4 4L19 7"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <div>
            <CardTitle className="text-2xl text-[var(--timberwolf)]">
              Recording Started
            </CardTitle>
            <CardDescription className="text-[var(--ash-grey)] mt-2 leading-relaxed">
              Your recording has been scheduled and will start shortly.
              We&apos;ll email you the link once it&apos;s ready.
            </CardDescription>
          </div>
        </CardHeader>
        {refId && (
          <CardContent>
            <Badge
              variant="outline"
              className="text-[var(--ash-grey)]/40 border-[var(--ash-grey)]/15"
            >
              Ref: {refId.slice(0, 12)}...
            </Badge>
          </CardContent>
        )}
      </Card>
    </div>
  )
}
