'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { getAppUser } from '@/lib/auth'
import { listNotifications, markRead, markAllRead, type NotificationRow } from '@/lib/notifications'

function timeAgo(iso: string) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24); return `${d}d ago`
}

export default function NotificationBell({ align = 'down' }: { align?: 'up' | 'down' }) {
  const supabase = createClient()
  const router = useRouter()
  const [uid, setUid] = useState<string | null>(null)
  const [items, setItems] = useState<NotificationRow[]>([])
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined
    let cancelled = false
    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      const au = user ? await getAppUser(supabase, user) : null
      if (!au || cancelled) return
      setUid(au.id)
      setItems(await listNotifications(supabase, au.id))
      timer = setInterval(async () => { if (!cancelled) setItems(await listNotifications(supabase, au.id)) }, 60000)
    })()
    return () => { cancelled = true; if (timer) clearInterval(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  const unread = items.filter((i) => !i.read).length

  const openItem = async (n: NotificationRow) => {
    if (!n.read) { markRead(supabase, n.id); setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, read: true } : x))) }
    setOpen(false)
    if (n.link) router.push(n.link)
  }
  const allRead = async () => { if (!uid) return; setItems((prev) => prev.map((x) => ({ ...x, read: true }))); await markAllRead(supabase, uid) }

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} title="Notifications" className="relative grid h-9 w-9 place-items-center rounded-lg text-neutral-300 hover:bg-white/10 hover:text-white transition-colors">
        <span className="text-lg leading-none">🔔</span>
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 grid place-items-center rounded-full bg-rose-500 text-white text-[10px] font-bold">{unread > 9 ? '9+' : unread}</span>
        )}
      </button>
      {open && (
        <div className={`absolute ${align === 'up' ? 'bottom-full mb-2' : 'top-full mt-2'} right-0 w-80 max-h-[24rem] overflow-y-auto bg-white text-neutral-900 rounded-xl shadow-2xl border border-neutral-200 z-50`}>
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-neutral-100 sticky top-0 bg-white">
            <span className="font-semibold text-sm">Notifications</span>
            {unread > 0 && <button onClick={allRead} className="text-xs text-violet-600 hover:underline">Mark all read</button>}
          </div>
          {items.length === 0 ? (
            <p className="p-6 text-center text-sm text-neutral-400">No notifications yet.</p>
          ) : (
            <ul className="divide-y divide-neutral-100">
              {items.map((n) => (
                <li key={n.id}>
                  <button onClick={() => openItem(n)} className={`w-full text-left px-4 py-3 hover:bg-neutral-50 transition-colors ${n.read ? '' : 'bg-violet-50/50'}`}>
                    <div className="flex items-start gap-2">
                      <span className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${n.read ? 'bg-transparent' : 'bg-violet-500'}`} />
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-neutral-900">{n.title}</div>
                        {n.body && <div className="text-xs text-neutral-500 mt-0.5">{n.body}</div>}
                        <div className="text-[10px] text-neutral-400 mt-1">{timeAgo(n.created_at)}</div>
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
