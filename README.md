# PLAYHUB

**Marketplace for Match Recordings and Professional Highlights**

PLAYHUB is a dedicated marketplace platform within the PLAYBACK ecosystem where organizations (clubs, academies, leagues) can sell full match recordings and professional highlight reels.

## 🚀 Quick Start

```bash
# Install dependencies
npm install

# Set up environment variables
cp .env.local.example .env.local
# Add your Supabase and Stripe credentials

# Run development server
npm run dev

# Build for production
npm run build
npm start
```

The application runs on `http://localhost:3001` (port 3001 to avoid conflict with PLAYBACK).

## 📁 Project Structure

```
PLAYHUB/
├── src/
│   ├── app/              # Next.js App Router
│   │   ├── globals.css   # Global styles
│   │   ├── layout.tsx    # Root layout
│   │   └── page.tsx      # Homepage
│   ├── components/       # React components
│   │   └── ui/          # shadcn/ui components
│   └── lib/             # Utilities
│       ├── supabase/    # Supabase clients (shared with PLAYBACK)
│       └── utils.ts     # Helper functions
├── public/              # Static assets
├── package.json
└── README.md
```

## 🔧 Tech Stack

- **Framework**: Next.js 14 with App Router
- **Language**: TypeScript (strict mode)
- **Database**: Supabase (shared with PLAYBACK)
- **Authentication**: Supabase Auth (cross-domain)
- **Payments**: Stripe
- **UI**: Tailwind CSS + shadcn/ui
- **Deployment**: Netlify (playhub.playbacksports.ai)

## 🔗 Shared Infrastructure

PLAYHUB shares infrastructure with PLAYBACK:

- **Database**: Same Supabase project
- **Authentication**: Shared auth system (single sign-on)
- **Storage**: Shared Supabase Storage buckets
- **Design System**: Consistent Tailwind theme

## 🗄️ Database Schema

### Core Tables (To Be Created)

- `match_recordings` - Match videos with provider flexibility
- `content_products` - Sellable content with pricing
- `purchase_history` - Transaction records
- `access_rights` - Content access control

See `docs/playhub-implementation-plan.md` for full schema details.

## 🎯 Features (Planned)

### Phase 1 (MVP)

- [x] Repository setup
- [x] Supabase integration
- [ ] Database schema implementation
- [ ] Match browsing page
- [ ] Match detail & purchase flow
- [ ] Stripe checkout integration
- [ ] User library page

### Phase 2

- [ ] Organization storefronts
- [ ] Content upload interface
- [ ] Advanced search & filters
- [ ] Video provider integrations (Veo, Spiideo, Pixellot)

### Phase 3

- [ ] Subscription/season pass features
- [ ] Analytics dashboard
- [ ] Mobile optimization
- [ ] Cross-promotion with PLAYScanner

## 🔐 Environment Variables

Required environment variables (see `.env.local.example`):

```bash
# Supabase (shared with PLAYBACK)
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=

# Stripe
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=
```

## 🚢 Deployment

PLAYHUB deploys independently to `playhub.playbacksports.ai` via Netlify.

```bash
# Build for production
npm run build

# Netlify will use this build command
# Output directory: .next
```

## 📝 Development Guidelines

1. **Follow PLAYBACK patterns** - Maintain consistency with main app
2. **Shared Supabase project** - Be careful with database changes
3. **Port 3001** - Run on different port than PLAYBACK (3000)
4. **TypeScript strict** - All code must be properly typed
5. **Tailwind classes** - Use design tokens from PLAYBACK

## 📚 Documentation

- Implementation Plan: `docs/playhub-implementation-plan.md`
- PLAYHUB Spec: `docs/PLAYHUB.md`
- Parent README: `../README.md`

## 🤝 Related Repositories

- **PLAYBACK**: Main platform (playbacksports.ai)
- **Parent Repo**: Documentation and shared specs

---

Built with ❤️ by Brain 2.0 Ltd
