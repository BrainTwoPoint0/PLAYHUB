import { getAuthUserStrict, createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation' // i18n-todo: locale-unaware redirect (drops /ar prefix); migrate with next-intl redirect in a later pass
import { User } from '@supabase/supabase-js'

// Server-side auth utilities (for server components and API routes only)
export async function getUser(): Promise<User | null> {
  const { user } = await getAuthUserStrict()
  return user
}

export async function requireAuth(): Promise<User> {
  const user = await getUser()
  if (!user) {
    redirect('/auth/login')
  }
  return user
}

export async function requireNoAuth(): Promise<void> {
  const user = await getUser()
  if (user) {
    redirect('/dashboard')
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
