'use client'

import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'

export default function LogoutButton({ className = '' }: { className?: string }) {
  const router = useRouter()
  const supabase = createClient()

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  return (
    <button
      onClick={handleLogout}
      className={`text-sm font-medium text-neutral-500 hover:text-red-600 hover:border-red-200 hover:bg-red-50 border border-neutral-200 rounded-lg px-3 py-1.5 transition-colors ${className}`}
    >
      Logout
    </button>
  )
}