'use client'

import { useState } from 'react'

const SIZE: Record<string, string> = {
  sm: 'h-9 w-auto',
  md: 'h-12 w-auto',
  lg: 'h-16 w-auto',
  xl: 'h-24 w-auto',
}

/**
 * Superclass by PhysicsWallah brand mark.
 * Uses the real logo image at /public/superclass-logo.png when present,
 * otherwise falls back to an SVG rendition so nothing ever breaks.
 */
export default function Logo({
  variant = 'full',
  onDark = false,
  size = 'md',
  className = '',
}: {
  variant?: 'full' | 'compact'
  onDark?: boolean
  size?: 'sm' | 'md' | 'lg' | 'xl'
  className?: string
}) {
  const [imgFailed, setImgFailed] = useState(false)

  if (variant === 'full' && !imgFailed) {
    // eslint-disable-next-line @next/next/no-img-element
    const img = (
      <img
        src="/superclass-logo.png"
        alt="Superclass by PhysicsWallah"
        className={SIZE[size]}
        onError={() => setImgFailed(true)}
      />
    )
    return onDark ? (
      <span className={`inline-flex items-center rounded-2xl bg-white px-4 py-2.5 shadow-lg ${className}`}>{img}</span>
    ) : (
      <span className={`inline-flex items-center ${className}`}>{img}</span>
    )
  }

  // ---- SVG fallback (only if /superclass-logo.png is missing) ----
  const circleFill = onDark ? '#ffffff' : '#0a0a0a'
  const letterFill = onDark ? '#0a0a0a' : '#ffffff'
  const classColor = onDark ? 'text-white' : 'text-neutral-900'
  const pill = onDark ? 'bg-white text-neutral-900' : 'bg-neutral-900 text-white'

  const badge = (
    <svg viewBox="0 0 100 100" className="h-9 w-9 shrink-0" aria-hidden="true">
      <circle cx="50" cy="50" r="47" fill={circleFill} />
      <circle cx="50" cy="50" r="41" fill="none" stroke={letterFill} strokeWidth="2" opacity="0.4" />
      <text x="50" y="49" textAnchor="middle" fontSize="30" fontWeight="800" fill={letterFill} fontFamily="Arial, Helvetica, sans-serif">P</text>
      <text x="50" y="82" textAnchor="middle" fontSize="30" fontWeight="800" fill={letterFill} fontFamily="Arial, Helvetica, sans-serif">W</text>
    </svg>
  )

  if (variant === 'compact') {
    return <span className={`inline-flex items-center ${className}`} aria-label="Superclass by PhysicsWallah">{badge}</span>
  }

  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`} aria-label="Superclass by PhysicsWallah">
      {badge}
      <span className="flex flex-col leading-none">
        <span className="text-lg font-extrabold tracking-tight">
          <span className="text-violet-500">SUPER</span>
          <span className={classColor}>CLASS</span>
        </span>
        <span className={`mt-1 inline-block self-start rounded-full px-2 py-0.5 text-[8px] font-bold tracking-wider ${pill}`}>
          BY PHYSICSWALLAH
        </span>
      </span>
    </span>
  )
}
