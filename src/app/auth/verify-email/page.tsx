import Link from 'next/link'
import { Mail } from 'lucide-react'
import { Button } from '@braintwopoint0/playback-commons/ui'

export default function VerifyEmailPage() {
  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="bg-zinc-900/50 border border-[var(--ash-grey)]/20 rounded-xl p-8 space-y-6 text-center">
          <div className="w-16 h-16 mx-auto rounded-full bg-[var(--timberwolf)]/10 flex items-center justify-center">
            <Mail className="h-8 w-8 text-[var(--timberwolf)]" />
          </div>

          <div>
            <h1 className="text-2xl font-bold text-[var(--timberwolf)] mb-2">
              Check your email
            </h1>
            <p className="text-sm text-[var(--ash-grey)]">
              We&apos;ve sent you a confirmation link. Click the link in your
              email to verify your account.
            </p>
          </div>

          <div className="pt-4 space-y-3">
            <p className="text-xs text-[var(--ash-grey)]">
              Didn&apos;t receive the email? Check your spam folder.
            </p>
            <Link href="/auth/login">
              <Button
                variant="outline"
                className="w-full border-[var(--ash-grey)]/30 text-[var(--timberwolf)] hover:bg-zinc-800"
              >
                Back to sign in
              </Button>
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}
