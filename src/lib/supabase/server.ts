import { createServerClient } from '@supabase/ssr'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import { Database } from './types'

export async function createClient() {
  const cookieStore = await cookies()

  const cookieDomain = process.env.NEXT_PUBLIC_COOKIE_DOMAIN

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      ...(cookieDomain && {
        cookieOptions: { domain: cookieDomain },
      }),
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(
          cookiesToSet: {
            name: string
            value: string
            options?: Record<string, unknown>
          }[]
        ) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // The `setAll` method was called from a Server Component.
            // This can be ignored if you have middleware refreshing
            // user sessions.
          }
        },
      },
    }
  )
}

// Get the authenticated user via local JWT signature verification (getClaims).
// Unlike getUser(), this does NOT make a round-trip to Supabase Auth on every
// call — it verifies the JWT cryptographically using cached JWKS keys. This
// prevents burning through the ~30 req/min auth rate limit while still
// providing signature verification (unlike getSession() which does no verification).
export async function getAuthUser() {
  const supabase = await createClient()
  try {
    const { data, error } = await supabase.auth.getClaims()
    if (error || !data) return { user: null, supabase }
    const { claims } = data
    // getClaims() returns JWT claims — reconstruct a User-like object
    // with the fields our routes use (id, email)
    const user = {
      id: claims.sub as string,
      email: (claims.email as string) ?? undefined,
      // Spread remaining claims for any code that accesses other fields
      ...claims,
    }
    return { user, supabase }
  } catch {
    // getClaims() throws plain Error (not AuthError) for expired JWTs.
    // Try refreshing the session before giving up — this handles the
    // Netlify race condition where middleware cookies don't propagate.
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (user) {
        return {
          user: { id: user.id, email: user.email ?? undefined },
          supabase,
        }
      }
    } catch {
      // Refresh also failed — truly unauthenticated
    }
    return { user: null, supabase }
  }
}

// Strict auth — validates the session with a full round-trip to Supabase Auth.
// Use this for security-critical routes: admin actions, payments, access grants.
// Revoked sessions are detected immediately (unlike getAuthUser which trusts
// the JWT until expiry).
export async function getAuthUserStrict() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return { user, supabase }
}

// Service role client - bypasses RLS (use with caution!)
export function createServiceClient() {
  return createSupabaseClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  )
}
