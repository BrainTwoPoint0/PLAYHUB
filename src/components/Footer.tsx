import Link from 'next/link'

export default function Footer() {
  return (
    <footer className="border-t border-[var(--ash-grey)]/20 mt-20">
      <div className="container mx-auto px-5 py-8">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
          {/* Brand */}
          <div className="col-span-1 md:col-span-2">
            <h3 className="text-xl font-bold text-[var(--timberwolf)] mb-2">
              PLAYHUB
            </h3>
            <p className="text-[var(--ash-grey)] text-sm">
              Your marketplace for professional match recordings and highlight
              reels.
            </p>
          </div>

          {/* Quick Links */}
          <div>
            <h4 className="text-sm font-semibold text-[var(--timberwolf)] mb-3">
              Quick Links
            </h4>
            <ul className="space-y-2">
              <li>
                <Link
                  href="/matches"
                  className="text-sm text-[var(--ash-grey)] hover:text-[var(--timberwolf)] transition-colors"
                >
                  Browse Matches
                </Link>
              </li>
              <li>
                <Link
                  href="/library"
                  className="text-sm text-[var(--ash-grey)] hover:text-[var(--timberwolf)] transition-colors"
                >
                  My Library
                </Link>
              </li>
            </ul>
          </div>

          {/* Legal */}
          <div>
            <h4 className="text-sm font-semibold text-[var(--timberwolf)] mb-3">
              Legal
            </h4>
            <ul className="space-y-2">
              <li>
                <Link
                  href="/terms"
                  className="text-sm text-[var(--ash-grey)] hover:text-[var(--timberwolf)] transition-colors"
                >
                  Terms of Service
                </Link>
              </li>
              <li>
                <Link
                  href="/privacy"
                  className="text-sm text-[var(--ash-grey)] hover:text-[var(--timberwolf)] transition-colors"
                >
                  Privacy Policy
                </Link>
              </li>
            </ul>
          </div>
        </div>

        {/* Copyright */}
        <div className="mt-8 pt-8 border-t border-[var(--ash-grey)]/10">
          <p className="text-center text-sm text-[var(--ash-grey)]">
            © {new Date().getFullYear()} PLAYHUB. Part of the PLAYBACK Sports
            ecosystem.
          </p>
        </div>
      </div>
    </footer>
  )
}
