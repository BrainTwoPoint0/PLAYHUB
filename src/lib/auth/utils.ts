import { getAuthUserStrict, createClient } from '@/lib/supabase/server'
import { getLocale } from 'next-intl/server'
import { redirect } from '@/i18n/navigation'
import { User } from '@supabase/supabase-js'

// Server-side auth utilities (for server components and API routes only)
export async function getUser(): Promise<User | null> {
  const { user } = await getAuthUserStrict()
  return user
}

export async function requireAuth(): Promise<User> {
  const user = await getUser()
  if (!user) {
    return redirect({ href: '/auth/login', locale: await getLocale() })
  }
  return user
}

export async function requireNoAuth(): Promise<void> {
  const user = await getUser()
  if (user) {
    redirect({ href: '/dashboard', locale: await getLocale() })
  }
}

export async function getUserProfile(userId: string) {
  const supabase = await createClient()
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('user_id', userId)
    .single()

  return { profile, error }
}
