'use client';

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useMemo,
  useCallback,
} from 'react';
import { User, Session, AuthError } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/client';
import { useRouter } from 'next/navigation';

interface UserProfile {
  id: string;
  user_id: string;
  username: string;
  email: string | null;
  full_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  cover_image_url: string | null;
  date_of_birth: string | null;
  height_cm: number | null;
  weight_kg: number | null;
  nationality: string | null;
  location: string | null;
  phone: string | null;
  website: string | null;
  social_links: any;
  is_public: boolean | null;
  created_at: string | null;
  updated_at: string | null;
}

interface ProfileState {
  data: UserProfile | null;
  loading: boolean;
  error: string | null;
  lastFetched: number | null;
}

interface AuthContextType {
  // Core auth
  user: User | null;
  session: Session | null;
  loading: boolean;

  // Unified profile state
  profile: ProfileState;
  isOnboardingComplete: boolean;

  // Actions
  signUp: (
    email: string,
    password: string,
    metadata?: Record<string, any>
  ) => Promise<{ data: any; error: AuthError | null }>;
  signIn: (
    email: string,
    password: string
  ) => Promise<{ error: AuthError | null }>;
  signOut: () => Promise<{ error: AuthError | null }>;
  resetPassword: (email: string) => Promise<{ error: AuthError | null }>;

  // Profile actions
  refreshProfile: (force?: boolean) => Promise<void>;
  updateProfile: (updates: Partial<UserProfile>) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Cache timeout: 5 minutes
const CACHE_TIMEOUT = 5 * 60 * 1000;

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<ProfileState>({
    data: null,
    loading: false,
    error: null,
    lastFetched: null,
  });

  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);

  // Profile is considered complete when it exists
  const isOnboardingComplete = useMemo(() => {
    return !!profile.data;
  }, [profile.data]);

  // Unified profile fetching function
  const fetchProfile = useCallback(
    async (userId: string) => {
      try {
        // First get the profile
        const { data: profileData, error: profileError } = await supabase
          .from('profiles')
          .select('*')
          .eq('user_id', userId)
          .single();

        if (profileError) throw profileError;

        const data = {
          ...profileData,
        };

        return { data, error: null };
      } catch (error) {
        return {
          data: null,
          error:
            error instanceof Error ? error.message : 'Failed to fetch profile',
        };
      }
    },
    [supabase]
  );

  // Smart refresh with caching
  const refreshProfile = useCallback(
    async (force = false) => {
      if (!user) {
        setProfile({
          data: null,
          loading: false,
          error: null,
          lastFetched: null,
        });
        return;
      }

      // Check cache validity
      const now = Date.now();
      const isCacheValid =
        profile.lastFetched && now - profile.lastFetched < CACHE_TIMEOUT;

      if (!force && isCacheValid && profile.data) {
        return; // Use cached data
      }

      setProfile((prev) => ({ ...prev, loading: true, error: null }));

      try {
        const result = await fetchProfile(user.id);
        setProfile({
          data: result.data,
          loading: false,
          error: result.error,
          lastFetched: now,
        });
      } catch (error) {
        setProfile((prev) => ({
          ...prev,
          loading: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        }));
      }
    },
    [user, profile.lastFetched, profile.data, fetchProfile]
  );

  // Optimistic updates for better UX
  const updateProfile = useCallback((updates: Partial<UserProfile>) => {
    setProfile((prev) => ({
      ...prev,
      data: prev.data ? { ...prev.data, ...updates } : null,
    }));
  }, []);

  // Initialize auth and profile
  useEffect(() => {
    const initializeAuth = async () => {
      try {
        const {
          data: { session },
          error,
        } = await supabase.auth.getSession();

        if (error) {
          console.error('Error getting session:', error);
        } else {
          setSession(session);
          setUser(session?.user ?? null);

          // Initialize profile state for authenticated users
          if (session?.user) {
            // Don't fetch profile here to avoid circular dependencies
            // Profile will be fetched via refreshProfile after auth is complete
            setProfile({
              data: null,
              loading: false,
              error: null,
              lastFetched: null,
            });
          }
        }
      } catch (error) {
        console.error('Session initialization error:', error);
      } finally {
        setLoading(false);
      }
    };

    initializeAuth();
  }, [supabase.auth]);

  // Fetch profile after auth is initialized
  useEffect(() => {
    if (!loading && user && !profile.data && !profile.loading) {
      // Call fetchProfile directly to avoid circular dependencies
      const loadProfile = async () => {
        setProfile((prev) => ({ ...prev, loading: true, error: null }));
        try {
          const result = await fetchProfile(user.id);
          setProfile({
            data: result.data,
            loading: false,
            error: result.error,
            lastFetched: Date.now(),
          });
        } catch (error) {
          setProfile((prev) => ({
            ...prev,
            loading: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          }));
        }
      };
      loadProfile();
    }
  }, [loading, user, profile.data, profile.loading, fetchProfile]);

  // Listen for auth changes
  useEffect(() => {
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, session) => {
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);

      if (session?.user) {
        // Reset profile state - will be fetched by the profile useEffect
        setProfile({
          data: null,
          loading: false,
          error: null,
          lastFetched: null,
        });
      } else {
        // Clear profile on sign out
        setProfile({
          data: null,
          loading: false,
          error: null,
          lastFetched: null,
        });
      }

      // Handle navigation
      if (event === 'SIGNED_IN') {
        router.refresh();
      } else if (event === 'SIGNED_OUT') {
        router.push('/');
        router.refresh();
      }
    });

    return () => subscription.unsubscribe();
  }, [supabase.auth, router]);

  // Auth actions with loading states
  const signUp = useCallback(
    async (email: string, password: string, metadata?: Record<string, any>) => {
      setLoading(true);
      try {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: metadata,
            emailRedirectTo: `${window.location.origin}/auth/callback`,
          },
        });
        return { data, error };
      } finally {
        setLoading(false);
      }
    },
    [supabase.auth]
  );

  const signIn = useCallback(
    async (email: string, password: string) => {
      setLoading(true);
      try {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        return { error };
      } finally {
        setLoading(false);
      }
    },
    [supabase.auth]
  );

  const signOut = useCallback(async () => {
    setLoading(true);
    try {
      const { error } = await supabase.auth.signOut();
      return { error };
    } finally {
      setLoading(false);
    }
  }, [supabase.auth]);

  const resetPassword = useCallback(
    async (email: string) => {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/auth/reset-password`,
      });
      return { error };
    },
    [supabase.auth]
  );

  // Memoized context value to prevent unnecessary re-renders
  const value = useMemo(
    () => ({
      user,
      session,
      loading,
      profile,
      isOnboardingComplete,
      signUp,
      signIn,
      signOut,
      resetPassword,
      refreshProfile,
      updateProfile,
    }),
    [
      user,
      session,
      loading,
      profile,
      isOnboardingComplete,
      refreshProfile,
      updateProfile,
      signIn,
      signOut,
      resetPassword,
      signUp,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

// Convenience hooks for specific data
export function useProfile() {
  const { profile, refreshProfile, updateProfile } = useAuth();
  return { profile, refreshProfile, updateProfile };
}

export function useOnboardingStatus() {
  const { isOnboardingComplete, profile } = useAuth();
  return {
    isComplete: isOnboardingComplete,
    loading: profile.loading,
    error: profile.error,
  };
}
