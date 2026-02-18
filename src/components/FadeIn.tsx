'use client'

import { useEffect, useRef, useState } from 'react'
import { cn } from '@braintwopoint0/playback-commons/utils'

export function FadeIn({
  children,
  className,
  delay = 0,
  direction = 'up',
}: {
  children: React.ReactNode
  className?: string
  delay?: number
  direction?: 'up' | 'left'
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { threshold: 0.1 }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={ref}
      className={cn(
        'transition-all duration-500 ease-out',
        visible
          ? 'opacity-100 translate-y-0 translate-x-0'
          : direction === 'left'
            ? 'opacity-0 -translate-x-5'
            : 'opacity-0 translate-y-6',
        className
      )}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </div>
  )
}
