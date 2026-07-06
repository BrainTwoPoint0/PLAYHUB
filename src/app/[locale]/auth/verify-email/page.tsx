import { getTranslations, setRequestLocale } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { Mail } from 'lucide-react'
import { Button } from '@braintwopoint0/playback-commons/ui'

// Server component using the i18n Link: needs its own setRequestLocale call
// (the layout's doesn't cover pages) to stay statically prerendered.
export default async function VerifyEmailPage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  setRequestLocale(locale)
  const t = await getTranslations('auth.verifyEmail')
  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="bg-zinc-900/50 border border-[var(--ash-grey)]/20 rounded-xl p-8 space-y-6 text-center">
          <div className="w-16 h-16 mx-auto rounded-full bg-[var(--timberwolf)]/10 flex items-center justify-center">
            <Mail className="h-8 w-8 text-[var(--timberwolf)]" />
          </div>

          <div>
            <h1 className="text-2xl font-bold text-[var(--timberwolf)] mb-2">
              {t('title')}
            </h1>
            <p className="text-sm text-[var(--ash-grey)]">
              {t('description')}
            </p>
          </div>

          <div className="pt-4 space-y-3">
            <p className="text-xs text-[var(--ash-grey)]">{t('spamHint')}</p>
            <Link href="/auth/login">
              <Button
                variant="outline"
                className="w-full border-[var(--ash-grey)]/30 text-[var(--timberwolf)] hover:bg-zinc-800"
              >
                {t('backToSignIn')}
              </Button>
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}
