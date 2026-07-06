// Shared player transport contract. The watch-page control bar (PlayerControlBar)
// is presentational and speaks only this interface, so the SAME bar can drive
// either the flat HTML5 <video> surface or the WebGL de-warp surface — both back
// onto one master <video> clock. See useVideoTransport for the HTML5 implementation.

export interface QualityLevel {
  index: number
  height: number
  bitrate: number
}

// A capability that a given surface can't support hides its control in the bar
// (e.g. HLS quality + PiP are master-video features, meaningless while de-warping).
export interface PlayerCapabilities {
  volume: boolean
  quality: boolean
  pip: boolean
  stepFrame: boolean
}

export interface PlayerTransportState {
  currentTime: number
  duration: number
  isPlaying: boolean
  hasPlayedOnce: boolean
  isLoading: boolean
  volume: number
  isMuted: boolean
  playbackRate: number
  bufferedEnd: number
  isPiP: boolean
  pipSupported: boolean
  qualityLevels: QualityLevel[]
  currentLevel: number
}
