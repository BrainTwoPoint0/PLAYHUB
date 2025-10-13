// Shared validation utilities that can be used in both client and server components
import { User } from '@supabase/supabase-js';

export function validateEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

export function validatePassword(password: string): {
  isValid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (password.length < 8) {
    errors.push('Password must be at least 8 characters long');
  }

  if (!/(?=.*[a-z])/.test(password)) {
    errors.push('Password must contain at least one lowercase letter');
  }

  if (!/(?=.*[A-Z])/.test(password)) {
    errors.push('Password must contain at least one uppercase letter');
  }

  if (!/(?=.*\d)/.test(password)) {
    errors.push('Password must contain at least one number');
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

export function validateUsername(username: string): {
  isValid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (username.length < 3) {
    errors.push('Username must be at least 3 characters long');
  }

  if (username.length > 30) {
    errors.push('Username cannot be longer than 30 characters');
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    errors.push(
      'Username can only contain letters, numbers, underscores, and hyphens'
    );
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

// Role and permission utilities
export function hasRole(user: User | null, role: string): boolean {
  if (!user) return false;
  return user.user_metadata?.role === role;
}

export function hasAnyRole(user: User | null, roles: string[]): boolean {
  if (!user) return false;
  return roles.includes(user.user_metadata?.role);
}

export function isPlayer(user: User | null): boolean {
  return hasRole(user, 'player');
}

export function isCoach(user: User | null): boolean {
  return hasRole(user, 'coach');
}

export function isScout(user: User | null): boolean {
  return hasRole(user, 'scout');
}

export function isFan(user: User | null): boolean {
  return hasRole(user, 'fan');
}

// Auth error handling
export function getAuthErrorMessage(error: any): string {
  if (!error) return 'An unknown error occurred';

  const message = error.message || error.error_description || error.toString();

  // Common Supabase auth error mappings
  const errorMappings: Record<string, string> = {
    'Invalid login credentials':
      'Invalid email or password. Please check your credentials and try again.',
    'Email not confirmed':
      'Please check your email and click the confirmation link before signing in.',
    'User already registered':
      'An account with this email address already exists. Please sign in instead.',
    'Password should be at least 6 characters':
      'Password must be at least 6 characters long.',
    'Signup requires a valid password': 'Please provide a valid password.',
    'Invalid email': 'Please provide a valid email address.',
    'Email rate limit exceeded':
      'Too many emails sent. Please wait before requesting another.',
    'duplicate key value violates unique constraint "profiles_username_key"':
      'This username is already taken. Please choose a different username.',
  };

  return errorMappings[message] || message;
}
