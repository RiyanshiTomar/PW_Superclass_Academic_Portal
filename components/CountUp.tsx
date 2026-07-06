'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * Animated number that counts up to `to` on mount / when `to` changes.
 * `format` maps the current value to a display string.
 */
export default function CountUp({
  to,
  duration = 900,
  format = (v: number) => String(Math.round(v)),
  className = '',
}: {
  to: number
  duration?: number
  format?: (v: number) => string
  className?: string
}) {
  const [val, setVal] = useState(0)
  const raf = useRef<number | undefined>(undefined)

  useEffect(() => {
    let startTs: number | null = null
    const step = (ts: number) => {
      if (startTs === null) startTs = ts
      const p = Math.min(1, (ts - startTs) / duration)
      const eased = 1 - Math.pow(1 - p, 3) // easeOutCubic
      setVal(to * eased)
      if (p < 1) raf.current = requestAnimationFrame(step)
    }
    raf.current = requestAnimationFrame(step)
    return () => { if (raf.current) cancelAnimationFrame(raf.current) }
  }, [to, duration])

  return <span className={className}>{format(val)}</span>
}
