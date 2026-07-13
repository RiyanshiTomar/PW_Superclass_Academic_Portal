import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// In-app notifications. Fire-and-forget helpers used across the app to alert
// the relevant user(s) when something needs their attention.
// ============================================================

export type NotificationInput = { type?: string; title: string; body?: string; link?: string | null }

export async function notifyUsers(supabase: SupabaseClient, userIds: (string | null | undefined)[], n: NotificationInput) {
  const ids = Array.from(new Set(userIds.filter((x): x is string => !!x)))
  if (ids.length === 0) return
  await supabase.from('notifications').insert(
    ids.map((user_id) => ({ user_id, type: n.type ?? 'info', title: n.title, body: n.body ?? '', link: n.link ?? null }))
  )
}

export async function notify(supabase: SupabaseClient, userId: string | null | undefined, n: NotificationInput) {
  await notifyUsers(supabase, [userId], n)
}

/** Notify every active user holding any of the given roles. */
export async function notifyRoles(supabase: SupabaseClient, roles: string[], n: NotificationInput) {
  const { data } = await supabase.from('app_users').select('id, role, roles').eq('status', 'active')
  const ids = ((data ?? []) as { id: string; role: string | null; roles: string[] | null }[])
    .filter((u) => (u.role && roles.includes(u.role)) || (u.roles ?? []).some((r) => roles.includes(r)))
    .map((u) => u.id)
  await notifyUsers(supabase, ids, n)
}

export type NotificationRow = { id: string; type: string; title: string; body: string; link: string | null; read: boolean; created_at: string }

export async function listNotifications(supabase: SupabaseClient, userId: string, limit = 30): Promise<NotificationRow[]> {
  const { data } = await supabase
    .from('notifications')
    .select('id, type, title, body, link, read, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit)
  return (data ?? []) as NotificationRow[]
}

export async function markRead(supabase: SupabaseClient, id: string) {
  await supabase.from('notifications').update({ read: true }).eq('id', id)
}

export async function markAllRead(supabase: SupabaseClient, userId: string) {
  await supabase.from('notifications').update({ read: true }).eq('user_id', userId).eq('read', false)
}
