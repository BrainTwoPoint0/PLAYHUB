import { createNavigation } from 'next-intl/navigation'
import { routing } from './routing'

// Locale-aware replacements for next/link and next/navigation. Components must
// import Link/useRouter/usePathname from here so hrefs keep the active locale
// prefix. useParams/useSearchParams/notFound are not wrapped by next-intl —
// keep importing those from next/navigation.
export const {
  Link,
  redirect,
  permanentRedirect,
  usePathname,
  useRouter,
  getPathname,
} = createNavigation(routing)
