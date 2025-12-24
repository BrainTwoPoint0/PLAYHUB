import Link from 'next/link'

export default function Footer() {
  return (
    <footer className="container mx-auto flex p-5 items-center justify-between border-t border-[var(--timberwolf)]">
      <p className="text-sm text-[var(--ash-grey)]">
        © {new Date().getFullYear()} PLAYHUB
      </p>
      <Link
        href="https://playbacksports.ai"
        className="text-sm text-[var(--ash-grey)] hover:text-[var(--timberwolf)] transition-colors"
      >
        by PLAYBACK
      </Link>
    </footer>
  )
}
