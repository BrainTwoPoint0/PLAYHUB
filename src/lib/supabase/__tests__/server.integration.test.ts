import { describe, it, expect } from 'vitest'
import { createServiceClient } from '@/lib/supabase/server'

const hasCredentials =
  !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
  !!process.env.SUPABASE_SERVICE_ROLE_KEY

describe.skipIf(!hasCredentials)('Supabase Integration', () => {
  it('queries profiles table without error', async () => {
    const supabase = createServiceClient()
    const { error } = await supabase
      .from('profiles')
      .select('id', { head: true, count: 'exact' })
      .limit(0)

    expect(error).toBeNull()
  })

  it('queries playhub_match_recordings table without error', async () => {
    const supabase = createServiceClient()
    const { error } = await supabase
      .from('playhub_match_recordings')
      .select('id', { head: true, count: 'exact' })
      .limit(0)

    expect(error).toBeNull()
  })
})
