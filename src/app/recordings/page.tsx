'use client'

import { motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { formatDateTime } from '@/lib/utils'

interface Recording {
  id: string
  title: string
  description?: string
  home_team: string
  away_team: string
  match_date: string
  venue?: string
  pitch_name?: string
  s3_key: string
  file_size_bytes?: number
  spiideo_game_id?: string
}

export default function RecordingsPage() {
  const [recordings, setRecordings] = useState<Recording[]>([])
  const [loading, setLoading] = useState(true)
  const [playingId, setPlayingId] = useState<string | null>(null)
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null)
  const [loadingPlayback, setLoadingPlayback] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [loginRequired, setLoginRequired] = useState(false)

  useEffect(() => {
    async function fetchRecordings() {
      try {
        const res = await fetch('/api/recordings')
        const data = await res.json()

        if (data.message === 'Login required to view recordings') {
          setLoginRequired(true)
          setRecordings([])
        } else {
          // Filter to only show recordings with S3 keys
          const withS3 =
            data.recordings?.filter((r: Recording) => r.s3_key) || []
          setRecordings(withS3)
        }
      } catch (error) {
        console.error('Error fetching recordings:', error)
      }
      setLoading(false)
    }

    fetchRecordings()
  }, [])

  const handlePlay = async (recording: Recording) => {
    if (playingId === recording.id) {
      // Already playing, close it
      setPlayingId(null)
      setPlaybackUrl(null)
      return
    }

    setLoadingPlayback(true)
    try {
      const res = await fetch(
        `/api/recordings?id=${recording.id}&action=playback`
      )
      const data = await res.json()
      if (data.playbackUrl) {
        setPlayingId(recording.id)
        setPlaybackUrl(data.playbackUrl)
      }
    } catch (error) {
      console.error('Error getting playback URL:', error)
    }
    setLoadingPlayback(false)
  }

  const handleDownload = async (recording: Recording) => {
    try {
      const res = await fetch(
        `/api/recordings?id=${recording.id}&action=download`
      )
      const data = await res.json()
      if (data.downloadUrl) {
        window.open(data.downloadUrl, '_blank')
      }
    } catch (error) {
      console.error('Error getting download URL:', error)
    }
  }

  const handleShare = async (recording: Recording) => {
    const shareUrl = `${window.location.origin}/api/recordings/share/${recording.id}`
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopiedId(recording.id)
      setTimeout(() => setCopiedId(null), 2000)
    } catch (error) {
      console.error('Error copying to clipboard:', error)
    }
  }

  return (
    <div className="min-h-screen bg-[var(--night)]">
      <div className="container mx-auto px-5 py-16">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="mb-12"
        >
          <h1 className="text-3xl md:text-5xl lg:text-6xl font-bold text-[var(--timberwolf)] mb-4">
            My Recordings
          </h1>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4">
            <p className="text-base md:text-xl text-[var(--ash-grey)]">
              Match recordings you have access to
            </p>
            <div className="px-4 py-2 bg-black/30 border border-[var(--ash-grey)]/20 rounded-xl">
              <span className="text-2xl font-bold text-[var(--timberwolf)]">
                {loading ? '...' : recordings.length}
              </span>
              <span className="text-[var(--ash-grey)]/60 ml-2">
                {recordings.length === 1 ? 'recording' : 'recordings'}
              </span>
            </div>
          </div>
        </motion.div>

        {/* Video Player Modal */}
        {playingId && playbackUrl && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-8 bg-black/50 border border-[var(--ash-grey)]/20 rounded-2xl overflow-hidden"
          >
            <div className="p-4 border-b border-[var(--ash-grey)]/20 flex items-center justify-between">
              <h2 className="text-sm md:text-lg font-semibold text-[var(--timberwolf)] truncate mr-2">
                Now Playing: {recordings.find((r) => r.id === playingId)?.title}
              </h2>
              <button
                onClick={() => {
                  setPlayingId(null)
                  setPlaybackUrl(null)
                }}
                className="p-2 hover:bg-white/10 rounded-lg transition-colors"
              >
                <svg
                  className="w-5 h-5 text-[var(--ash-grey)]"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
            <div className="aspect-video bg-black">
              <video
                src={playbackUrl}
                controls
                autoPlay
                className="w-full h-full"
              />
            </div>
          </motion.div>
        )}

        {/* Recordings List */}
        {loading ? (
          <div className="space-y-4">
            {[1, 2, 3, 4, 5].map((i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 0.3, y: 0 }}
                transition={{ duration: 0.4, delay: i * 0.05 }}
                className="h-24 bg-black/20 border border-[var(--ash-grey)]/10 rounded-xl animate-pulse"
              />
            ))}
          </div>
        ) : loginRequired ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5 }}
            className="text-center py-24"
          >
            <div className="text-7xl mb-6 opacity-30">🔒</div>
            <p className="text-2xl md:text-3xl font-bold text-[var(--timberwolf)] mb-3">
              Login Required
            </p>
            <p className="text-base md:text-lg text-[var(--ash-grey)]/60 mb-6">
              Please log in to view your recordings
            </p>
            <a
              href="/auth/login"
              className="inline-block px-6 py-3 bg-white/10 hover:bg-white/20 border border-[var(--ash-grey)]/20 rounded-lg text-[var(--timberwolf)] transition-colors"
            >
              Log In
            </a>
          </motion.div>
        ) : recordings.length > 0 ? (
          <div className="space-y-4">
            {recordings.map((recording, idx) => (
              <motion.div
                key={recording.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: idx * 0.03 }}
                className={`bg-black/30 border rounded-xl overflow-hidden transition-all ${
                  playingId === recording.id
                    ? 'border-[var(--accent-purple)] shadow-lg shadow-purple-500/20'
                    : 'border-[var(--ash-grey)]/10 hover:border-[var(--ash-grey)]/30'
                }`}
              >
                <div className="p-4 md:p-5 space-y-3">
                  {/* Top row: Play button + Info */}
                  <div className="flex items-center gap-3 md:gap-5">
                    {/* Play Button */}
                    <button
                      onClick={() => handlePlay(recording)}
                      disabled={loadingPlayback}
                      className={`flex-shrink-0 w-12 h-12 md:w-14 md:h-14 rounded-full flex items-center justify-center transition-all ${
                        playingId === recording.id
                          ? 'bg-[var(--accent-purple)] text-white'
                          : 'bg-white/10 text-[var(--timberwolf)] hover:bg-white/20'
                      }`}
                    >
                      {loadingPlayback && playingId !== recording.id ? (
                        <svg
                          className="w-5 h-5 md:w-6 md:h-6 animate-spin"
                          fill="none"
                          viewBox="0 0 24 24"
                        >
                          <circle
                            className="opacity-25"
                            cx="12"
                            cy="12"
                            r="10"
                            stroke="currentColor"
                            strokeWidth="4"
                          />
                          <path
                            className="opacity-75"
                            fill="currentColor"
                            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                          />
                        </svg>
                      ) : playingId === recording.id ? (
                        <svg
                          className="w-5 h-5 md:w-6 md:h-6"
                          fill="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                        </svg>
                      ) : (
                        <svg
                          className="w-5 h-5 md:w-6 md:h-6 ml-0.5"
                          fill="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path d="M8 5v14l11-7z" />
                        </svg>
                      )}
                    </button>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <h3 className="text-base md:text-lg font-semibold text-[var(--timberwolf)] truncate">
                        {recording.title}
                      </h3>
                      <div className="mt-1 text-sm text-[var(--ash-grey)]/60">
                        <span>{formatDateTime(recording.match_date)}</span>
                      </div>
                    </div>
                  </div>

                  {/* Actions row */}
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleShare(recording)}
                      className={`flex-1 md:flex-none px-4 py-2 border rounded-lg text-sm transition-colors flex items-center justify-center gap-2 ${
                        copiedId === recording.id
                          ? 'bg-green-500/20 border-green-500/50 text-green-400'
                          : 'bg-white/5 hover:bg-white/10 border-[var(--ash-grey)]/20 text-[var(--timberwolf)]'
                      }`}
                    >
                      {copiedId === recording.id ? (
                        <>
                          <svg
                            className="w-4 h-4"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M5 13l4 4L19 7"
                            />
                          </svg>
                          Copied!
                        </>
                      ) : (
                        <>
                          <svg
                            className="w-4 h-4"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"
                            />
                          </svg>
                          Share
                        </>
                      )}
                    </button>
                    <button
                      onClick={() => handleDownload(recording)}
                      className="flex-1 md:flex-none px-4 py-2 bg-white/5 hover:bg-white/10 border border-[var(--ash-grey)]/20 rounded-lg text-sm text-[var(--timberwolf)] transition-colors flex items-center justify-center gap-2"
                    >
                      <svg
                        className="w-4 h-4"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                        />
                      </svg>
                      Download
                    </button>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        ) : (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5 }}
            className="text-center py-24"
          >
            <div className="text-7xl mb-6 opacity-30">🎬</div>
            <p className="text-2xl md:text-3xl font-bold text-[var(--timberwolf)] mb-3">
              No recordings yet
            </p>
            <p className="text-base md:text-lg text-[var(--ash-grey)]/60">
              Recordings will appear here once transferred from Spiideo
            </p>
          </motion.div>
        )}
      </div>
    </div>
  )
}
