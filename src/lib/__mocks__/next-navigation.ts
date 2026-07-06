export const useRouter = () => ({
  push: () => {},
  replace: () => {},
  refresh: () => {},
  back: () => {},
  forward: () => {},
  prefetch: () => {},
})

export const usePathname = () => '/'
export const useSearchParams = () => new URLSearchParams()
export const useParams = () => ({})
export const redirect = () => {}
// next-intl's createNavigation wraps this at module init — it must exist
// even though no test triggers a permanent redirect.
export const permanentRedirect = () => {}
export const notFound = () => {
  throw new Error('NEXT_NOT_FOUND')
}
