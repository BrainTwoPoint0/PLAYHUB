import { createClient } from '@/lib/supabase/client';

// Client-side auth utilities
export function useRequireAuth() {
  const supabase = createClient();

  return {
    checkAuth: async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        window.location.href = '/auth/login';
        return null;
      }
      return user;
    },
  };
}
