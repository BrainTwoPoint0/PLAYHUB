// Typed errors so API routes can branch on a stable `code` instead of regex-
// matching human-readable messages (which silently break when reworded).

/** The connection is unusable and the user must (re)authorize. */
export class TikTokAuthError extends Error {
  readonly code: 'not_connected' | 'needs_reconnect'
  constructor(code: 'not_connected' | 'needs_reconnect', message: string) {
    super(message)
    this.name = 'TikTokAuthError'
    this.code = code
  }
}

/** The caller supplied an unusable video (client-side, not an upstream fault). */
export class TikTokUploadError extends Error {
  readonly code: 'empty' | 'too_large'
  constructor(code: 'empty' | 'too_large', message: string) {
    super(message)
    this.name = 'TikTokUploadError'
    this.code = code
  }
}

/**
 * A token refresh failed. `invalid` distinguishes a definitively dead refresh
 * token (deactivate the connection) from a transient failure such as a 5xx or
 * network blip (leave the connection active so the next request can retry).
 */
export class TikTokRefreshError extends Error {
  readonly invalid: boolean
  constructor(invalid: boolean, message: string) {
    super(message)
    this.name = 'TikTokRefreshError'
    this.invalid = invalid
  }
}
