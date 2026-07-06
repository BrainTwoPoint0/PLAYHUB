'use client'

// Logo / sponsor overlay for the flat production surface. Prefers the newer
// percentage-positioned graphicPackage; falls back to the legacy corner-anchored
// mediaPack. Extracted verbatim from VideoPlayer so both VideoPlayer and the
// unified WatchPlayer render identical branding. Only meaningful on the FLAT
// surface — the logos are baked to flat-frame coordinates and would float wrong
// on the re-projected de-warp surface, so WatchPlayer renders this only in flat mode.

export interface MediaPack {
  logo_url?: string
  logo_position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  sponsor_logo_url?: string
  sponsor_position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
}

export interface GraphicPackageOverlay {
  logo_url: string | null
  logo_position: string
  logo_x?: number | null
  logo_y?: number | null
  logo_scale?: number | null
  sponsor_logo_url: string | null
  sponsor_position: string
  sponsor_x?: number | null
  sponsor_y?: number | null
  sponsor_scale?: number | null
}

interface GraphicsOverlayProps {
  mediaPack?: MediaPack
  graphicPackage?: GraphicPackageOverlay
}

export function GraphicsOverlay({
  mediaPack,
  graphicPackage,
}: GraphicsOverlayProps) {
  const logoUrl = graphicPackage?.logo_url || mediaPack?.logo_url
  const sponsorUrl =
    graphicPackage?.sponsor_logo_url || mediaPack?.sponsor_logo_url

  // Use percentage-based positioning if available, else fall back to corner positions
  const hasPercentPos = graphicPackage?.logo_x != null
  const logoX = graphicPackage?.logo_x ?? 85
  const logoY = graphicPackage?.logo_y ?? 3
  const logoScale = graphicPackage?.logo_scale ?? 8
  const sponsorX = graphicPackage?.sponsor_x ?? 3
  const sponsorY = graphicPackage?.sponsor_y ?? 85
  const sponsorScale = graphicPackage?.sponsor_scale ?? 10

  if (hasPercentPos) {
    return (
      <>
        {logoUrl && (
          <img
            src={logoUrl}
            alt=""
            className="absolute pointer-events-none object-contain opacity-80"
            style={{
              left: `${logoX}%`,
              top: `${logoY}%`,
              width: `${logoScale}%`,
              maxWidth: '250px',
              transform: 'translate(-50%, -50%)',
            }}
          />
        )}
        {sponsorUrl && (
          <img
            src={sponsorUrl}
            alt=""
            className="absolute pointer-events-none object-contain opacity-80"
            style={{
              left: `${sponsorX}%`,
              top: `${sponsorY}%`,
              width: `${sponsorScale}%`,
              maxWidth: '250px',
              transform: 'translate(-50%, -50%)',
            }}
          />
        )}
      </>
    )
  }

  // Legacy fallback: fixed corner positions from mediaPack
  const logoPos = mediaPack?.logo_position || 'top-right'
  const sponsorPos = mediaPack?.sponsor_position || 'bottom-left'
  const posClass = (pos: string) =>
    pos === 'top-left'
      ? 'top-3 left-3'
      : pos === 'top-right'
        ? 'top-3 right-3'
        : pos === 'bottom-left'
          ? 'bottom-16 left-3'
          : 'bottom-16 right-3'
  return (
    <>
      {logoUrl && (
        <img
          src={logoUrl}
          alt=""
          className={`absolute pointer-events-none w-12 h-12 md:w-16 md:h-16 object-contain opacity-70 ${posClass(logoPos)}`}
        />
      )}
      {sponsorUrl && (
        <img
          src={sponsorUrl}
          alt=""
          className={`absolute pointer-events-none w-12 h-12 md:w-16 md:h-16 object-contain opacity-70 ${posClass(sponsorPos)}`}
        />
      )}
    </>
  )
}
