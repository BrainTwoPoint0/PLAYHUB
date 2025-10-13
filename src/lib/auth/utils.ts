import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { User } from '@supabase/supabase-js';

// Server-side auth utilities (for server components and API routes only)
export async function getUser(): Promise<User | null> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

export async function requireAuth(): Promise<User> {
  const user = await getUser();
  if (!user) {
    redirect('/auth/login');
  }
  return user;
}

export async function requireNoAuth(): Promise<void> {
  const user = await getUser();
  if (user) {
    redirect('/dashboard');
  }
}

export async function getUserProfile(userId: string) {
  const supabase = createClient();
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('user_id', userId)
    .single();

  return { profile, error };
}

export async function createUserProfile(
  user: User,
  additionalData?: Record<string, any>
) {
  const supabase = createClient();

  const profileData = {
    user_id: user.id,
    username: user.user_metadata?.username || user.email?.split('@')[0] || '',
    full_name: user.user_metadata?.full_name || '',
    avatar_url: user.user_metadata?.avatar_url || '',
    ...additionalData,
  };

  const { data, error } = await supabase
    .from('profiles')
    .insert(profileData)
    .select()
    .single();

  return { data, error };
}
