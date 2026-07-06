import createNextIntlPlugin from 'next-intl/plugin'

const withNextIntl = createNextIntlPlugin()

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Dev writes to its own dir so `npm run build` (release script, pre-push
  // hook) can't clobber a running dev server's build output.
  distDir: process.env.NODE_ENV === 'development' ? '.next-dev' : '.next',
  experimental: {
    middlewareClientMaxBodySize: '500mb',
  },
  images: {
    domains: ['cdn.sanity.io'],
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**.supabase.co',
      },
    ],
  },
  webpack: (config, { dev }) => {
    if (dev) {
      config.watchOptions = {
        ...config.watchOptions,
        ignored: ['**/infrastructure/**', '**/node_modules/**'],
      }
    }
    return config
  },
}

export default withNextIntl(nextConfig)
