'use client'

import { usePathname } from 'next/navigation'
import { useEffect } from 'react'

// Counts one view per page opened, for the admin Usage Report. Fire-and-forget
// (sendBeacon) so it never slows a page down.
export default function UsageTracker() {
  const pathname = usePathname()
  useEffect(() => {
    if (!pathname || pathname === '/login' || pathname.startsWith('/auth/')) return
    const body = JSON.stringify({ path: pathname })
    try {
      if (!navigator.sendBeacon?.('/api/track', body)) fetch('/api/track', { method: 'POST', body, keepalive: true }).catch(() => {})
    } catch { /* tracking must never break the page */ }
  }, [pathname])
  return null
}
