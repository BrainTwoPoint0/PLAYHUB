import { JetBrains_Mono } from 'next/font/google'

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
})

export default function EditorLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div
      className={`fixed inset-0 z-50 flex flex-col overflow-hidden ${jetbrainsMono.variable}`}
      style={{ background: '#070c09' }}
    >
      {children}
    </div>
  )
}
