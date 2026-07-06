import { notFound } from 'next/navigation'

// Funnels every unmatched path into [locale]/not-found.tsx so 404s render
// inside the locale layout (NavBar/Footer, correct lang/dir).
export default function CatchAllPage() {
  notFound()
}
