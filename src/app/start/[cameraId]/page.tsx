'use client'

import { useState, useEffect } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { loadStripe } from '@stripe/stripe-js'
import {
  Elements,
  PaymentElement,
  useStripe,
  useElements,
} from '@stripe/react-stripe-js'
import {
  Button,
  Input,
  Label,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  CardFooter,
  Badge,
} from '@braintwopoint0/playback-commons/ui'
import { Check } from 'lucide-react'

const stripePromise = loadStripe(
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!
)

interface BookingConfig {
  venueName: string
  sceneName: string
  durations: number[]
  price: number
  currency: string
  chargePrice: number
  chargeCurrency: string
}

// Inner component that uses Stripe hooks (must be inside <Elements>)
function CheckoutForm({
  cameraId,
  onSuccess,
}: {
  cameraId: string
  onSuccess: () => void
}) {
  const stripe = useStripe()
  const elements = useElements()
  const [processing, setProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!stripe || !elements) return

    setProcessing(true)
    setError(null)

    const { error: submitError } = await elements.submit()
    if (submitError) {
      setError(submitError.message || 'Payment failed')
      setProcessing(false)
      return
    }

    const { error: confirmError } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: `${window.location.origin}/start/${cameraId}/success`,
      },
      redirect: 'if_required',
    })

    if (confirmError) {
      setError(confirmError.message || 'Payment failed')
      setProcessing(false)
    } else {
      // Payment succeeded without redirect (wallet payments)
      onSuccess()
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <PaymentElement
        options={{
          layout: 'tabs',
        }}
      />

      {error && (
        <Card className="bg-red-500/[0.07] border-red-500/20">
          <CardContent className="py-3 px-4">
            <p className="text-red-400/90 text-sm text-center">{error}</p>
          </CardContent>
        </Card>
      )}

      <Button
        type="submit"
        variant="playback"
        disabled={!stripe || !elements || processing}
        className="w-full h-12"
      >
        {processing ? (
          <span className="flex items-center gap-2">
            <span className="w-4 h-4 border-2 border-current/30 border-t-current rounded-full animate-spin" />
            Processing
          </span>
        ) : (
          <>Confirm Payment</>
        )}
      </Button>
    </form>
  )
}

export default function StartRecordingPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const cameraId = params.cameraId as string
  const canceled = searchParams.get('canceled')

  const [config, setConfig] = useState<BookingConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [selectedDuration, setSelectedDuration] = useState<number | null>(null)
  const [showDurationPicker, setShowDurationPicker] = useState(false)
  const [email, setEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Payment phase state
  const [clientSecret, setClientSecret] = useState<string | null>(null)

  // Success phase state
  const [paymentSuccess, setPaymentSuccess] = useState(false)

  useEffect(() => {
    fetch(`/api/start/${cameraId}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.error) {
          setError(data.error)
        } else {
          setConfig(data)
          setSelectedDuration(data.durations[0])
        }
      })
      .catch(() => setError('Failed to load booking info'))
      .finally(() => setLoading(false))
  }, [cameraId])

  const isValidEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!selectedDuration || !isValidEmail) return

    setSubmitting(true)
    setError(null)

    try {
      const res = await fetch(`/api/start/${cameraId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ durationMinutes: selectedDuration, email }),
      })

      const data = await res.json()
      if (data.error) {
        setError(data.error)
        setSubmitting(false)
        return
      }

      if (data.clientSecret) {
        setClientSecret(data.clientSecret)
        setSubmitting(false)
      }
    } catch {
      setError('Something went wrong. Please try again.')
      setSubmitting(false)
    }
  }

  // --- Loading state ---
  if (loading) {
    return (
      <div className="min-h-[100dvh] bg-[var(--night)] flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-5 h-5 border-2 border-[var(--ash-grey)]/30 border-t-[var(--timberwolf)] rounded-full animate-spin" />
          <p className="text-sm text-[var(--ash-grey)]">Loading</p>
        </div>
      </div>
    )
  }

  // --- Fatal error (no config loaded) ---
  if (error && !config) {
    return (
      <div className="min-h-[100dvh] bg-[var(--night)] flex items-center justify-center p-6">
        <Card className="max-w-[400px] w-full bg-transparent border-red-400/20 text-center">
          <CardContent className="pt-6 space-y-3">
            <Badge variant="destructive" className="mx-auto">
              Error
            </Badge>
            <p className="text-red-400/90 text-sm">{error}</p>
            <p className="text-[var(--ash-grey)]/50 text-xs">
              Try scanning the QR code again
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (!config) return null

  // Format price: 3 decimal places for KWD, 2 for everything else
  const formattedPrice =
    config.currency === 'KWD'
      ? config.price.toFixed(3)
      : config.price.toFixed(2)

  const showConversion = config.currency !== config.chargeCurrency
  const formattedChargePrice = config.chargePrice.toFixed(2)

  // --- Success phase ---
  if (paymentSuccess) {
    return (
      <div className="min-h-[100dvh] bg-[var(--night)] flex items-center justify-center p-6">
        <Card className="max-w-[400px] w-full bg-transparent border-[var(--ash-grey)]/10 text-center">
          <CardHeader className="space-y-4">
            <div className="w-16 h-16 mx-auto rounded-full border border-emerald-400/30 bg-emerald-400/[0.06] flex items-center justify-center">
              <Check className="h-7 w-7 text-emerald-400" />
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
        </Card>
      </div>
    )
  }

  return (
    <div className="min-h-[100dvh] bg-[var(--night)] flex flex-col items-center justify-center px-5 py-8">
      <Card className="max-w-[400px] w-full bg-transparent border-[var(--ash-grey)]/10 rounded-xl">
        <CardHeader className="text-center pb-2">
          <CardDescription className="text-[10px] font-medium tracking-[0.2em] uppercase text-[var(--ash-grey)]/60">
            Record your game
          </CardDescription>
          <CardTitle className="text-2xl text-[var(--timberwolf)]">
            {config.venueName}
          </CardTitle>
          <Badge
            variant="outline"
            className="mx-auto text-[var(--ash-grey)] border-[var(--ash-grey)]/20"
          >
            {config.sceneName}
          </Badge>
        </CardHeader>

        <CardContent className="space-y-6">
          {/* --- Canceled banner --- */}
          {canceled && !clientSecret && (
            <Card className="bg-amber-500/[0.07] border-amber-500/20">
              <CardContent className="py-3 px-4">
                <p className="text-amber-300/90 text-sm text-center">
                  Payment was cancelled. You can try again below.
                </p>
              </CardContent>
            </Card>
          )}

          {/* --- Inline error --- */}
          {error && !clientSecret && (
            <Card className="bg-red-500/[0.07] border-red-500/20">
              <CardContent className="py-3 px-4">
                <p className="text-red-400/90 text-sm text-center">{error}</p>
              </CardContent>
            </Card>
          )}

          {/* --- Payment phase: Stripe Elements --- */}
          {clientSecret ? (
            <Elements
              stripe={stripePromise}
              options={{
                clientSecret,
                appearance: {
                  theme: 'night',
                  variables: {
                    colorPrimary: '#d6d5c9',
                    colorBackground: '#0a100d',
                    colorText: '#d6d5c9',
                    colorTextSecondary: '#b9baa3',
                    colorDanger: '#f87171',
                    borderRadius: '8px',
                    fontFamily: 'Inter, system-ui, sans-serif',
                  },
                },
              }}
            >
              {/* Summary */}
              <Card className="bg-white/[0.02] border-[var(--ash-grey)]/10 rounded-xl">
                <CardContent className="py-4 px-5">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-[var(--timberwolf)]">
                        {selectedDuration} min recording
                      </p>
                      <p className="text-xs text-[var(--ash-grey)]/50 mt-0.5">
                        {email}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-lg font-semibold text-[var(--timberwolf)]">
                        {formattedPrice}
                        <span className="text-xs font-normal text-[var(--ash-grey)] ml-1">
                          {config.currency}
                        </span>
                      </p>
                      {showConversion && (
                        <p className="text-xs text-[var(--ash-grey)]/50">
                          ≈ {formattedChargePrice}{' '}
                          {config.chargeCurrency.toUpperCase()}
                        </p>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>

              <CheckoutForm
                cameraId={cameraId}
                onSuccess={() => setPaymentSuccess(true)}
              />
            </Elements>
          ) : (
            /* --- Form phase --- */
            <form onSubmit={handleSubmit} className="space-y-6">
              {/* --- Price --- */}
              <Card className="bg-white/[0.02] border-[var(--ash-grey)]/10 mt-2 rounded-xl">
                <CardContent className="py-5 px-6 text-center">
                  <p className="text-3xl font-semibold tracking-tight text-[var(--timberwolf)]">
                    {formattedPrice}
                    <span className="text-sm font-normal text-[var(--ash-grey)] ml-1.5">
                      {config.currency}
                    </span>
                  </p>
                  {showConversion && (
                    <p className="text-sm text-[var(--ash-grey)]/70 mt-1">
                      ≈ {formattedChargePrice}{' '}
                      {config.chargeCurrency.toUpperCase()}
                    </p>
                  )}
                  <p className="text-[10px] text-[var(--ash-grey)]/50 mt-1.5 tracking-wide uppercase">
                    Flat rate per recording
                  </p>
                </CardContent>
              </Card>

              {/* --- Duration --- */}
              <div className="space-y-2">
                <Label className="text-xs tracking-wide uppercase text-[var(--ash-grey)]/70">
                  Duration
                </Label>
                {!showDurationPicker ? (
                  <div className="flex items-center gap-2">
                    <div className="flex-1 flex h-10 w-full rounded-lg bg-zinc-800 text-white shadow-input px-3 py-2 text-sm shadow-[0px_0px_1px_1px_var(--neutral-700)] items-center justify-center">
                      {selectedDuration} minutes
                    </div>
                    {config.durations.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => setShowDurationPicker(true)}
                        className="text-[var(--ash-grey)] hover:text-[var(--timberwolf)] text-xs shrink-0"
                      >
                        Change
                      </Button>
                    )}
                  </div>
                ) : (
                  <div
                    className="grid gap-2"
                    style={{
                      gridTemplateColumns: `repeat(${Math.min(config.durations.length, 3)}, 1fr)`,
                    }}
                  >
                    {config.durations.map((d) => (
                      <Button
                        key={d}
                        type="button"
                        variant="outline"
                        onClick={() => {
                          setSelectedDuration(d)
                          setShowDurationPicker(false)
                        }}
                        className={`
                          h-10
                          ${
                            selectedDuration === d
                              ? 'bg-[var(--timberwolf)]/[0.08] border-[var(--timberwolf)]/60 text-[var(--timberwolf)]'
                              : 'bg-white/[0.02] border-[var(--ash-grey)]/15 text-[var(--ash-grey)] hover:border-[var(--ash-grey)]/30 hover:bg-white/[0.03]'
                          }
                        `}
                      >
                        {d} min
                      </Button>
                    ))}
                  </div>
                )}
              </div>

              {/* --- Email --- */}
              <div className="space-y-2">
                <Label
                  htmlFor="email"
                  className="text-xs tracking-wide uppercase text-[var(--ash-grey)]/70"
                >
                  Email address
                </Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="your@email.com"
                  required
                  autoComplete="email"
                />
                <p className="text-xs text-[var(--ash-grey)]/50">
                  We&apos;ll send the recording link to this email
                </p>
              </div>

              {/* --- Submit --- */}
              <Button
                type="submit"
                variant="playback"
                disabled={!selectedDuration || !isValidEmail || submitting}
                className="w-full h-12"
              >
                {submitting ? (
                  <span className="flex items-center gap-2">
                    <span className="w-4 h-4 border-2 border-current/30 border-t-current rounded-full animate-spin" />
                    Loading payment
                  </span>
                ) : (
                  <>Pay & Start Recording &rarr;</>
                )}
              </Button>
            </form>
          )}
        </CardContent>

        {!clientSecret && (
          <CardFooter className="justify-center">
            <p className="text-[11px] text-[var(--ash-grey)]/40 tracking-wide">
              Supports Apple Pay, Google Pay, and card payments
            </p>
          </CardFooter>
        )}
      </Card>
    </div>
  )
}
