'use client'

import { useEffect } from 'react'
import { usePathname, useRouter } from 'next/navigation'

/** Client guard: if the current path isn't `allow` (or a sub-path of it),
 *  send the user to `redirectTo`. Used to keep a scoped role (e.g. a
 *  syllabus-only editor) inside its one allowed admin page. */
export default function RouteScope({ allow, redirectTo }: { allow: string; redirectTo: string }) {
  const pathname = usePathname()
  const router = useRouter()
  useEffect(() => {
    if (pathname !== allow && !pathname.startsWith(allow + '/')) router.replace(redirectTo)
  }, [pathname, allow, redirectTo, router])
  return null
}
