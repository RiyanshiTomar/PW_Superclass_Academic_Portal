'use client'

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, BtnPrimary, BtnSecondary, Card, PageHeader } from '@/components/PortalShell'
import { PORTAL_LABEL, istDay } from '@/lib/usage'

type UserRow = { id: string; name: string; email: string; status: string; roles: string[]; centres: string[]; lastSignIn: string | null; actions: Record<string, number> }
type UsageRow = { user_id: string; day: string; section: string; portal: string | null; hits: number; first_at: string; last_at: string }
type Data = { from: string; to: string; trackingSince: string | null; users: UserRow[]; usage: UsageRow[]; logins: { user_id: string; at: string }[] }

const ROLE_LABEL: Record<string, string> = {
  admin: 'Admin', central_team: 'Central Team', faculty: 'Faculty', branch_head: 'Branch Head', batch_manager: 'Batch Manager',
  progress_reviewer: 'Progress Reviewer', syllabus_editor: 'Syllabus Editor', centre_admin: 'Centre Admin',
}
const roleName = (r: string) => ROLE_LABEL[r] ?? r
const shiftDay = (d: string, n: number) => { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10) }
const fmtDay = (d: string) => new Date(d + 'T12:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })
const fmtWhen = (ts: string | null) => (ts ? new Date(ts).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—')
const pageName = (section: string) => {
  const [, portal, ...rest] = section.split('/')
  const p = PORTAL_LABEL[portal || 'home'] ?? portal
  return rest.length ? `${p} › ${rest.filter((x) => x !== ':id').map((x) => x.replace(/-/g, ' ')).join(' › ') || 'detail'}` : `${p} home`
}
const label = 'block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1'
const field = 'h-9 px-3 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-400'

export default function UsageReportPage() {
  const today = istDay()
  const [from, setFrom] = useState(shiftDay(today, -29))
  const [to, setTo] = useState(today)
  const [role, setRole] = useState('')
  const [centre, setCentre] = useState('')
  const [showInactive, setShowInactive] = useState(false)
  const [data, setData] = useState<Data | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  const load = useCallback(async (f: string, t: string) => {
    setLoading(true); setErr(null)
    try {
      const res = await fetch(`/api/admin/usage?from=${f}&to=${t}`, { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Could not load the report.')
      setData(json)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load the report.')
    }
    setLoading(false)
  }, [])
  // First load only; Refresh re-runs with the chosen dates.
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { load(from, to) }, [])

  const preset = (days: number | 'month') => {
    const f = days === 'month' ? today.slice(0, 8) + '01' : shiftDay(today, -(days - 1))
    setFrom(f); setTo(today); load(f, today)
  }

  // Every day of the range (for the chart and "active days").
  const days = useMemo(() => {
    if (!data) return [] as string[]
    const out: string[] = []
    for (let d = data.from; d <= data.to; d = shiftDay(d, 1)) out.push(d)
    return out
  }, [data])

  const centreOptions = useMemo(() => Array.from(new Set((data?.users ?? []).flatMap((u) => u.centres))).sort(), [data])
  const roleOptions = useMemo(() => Array.from(new Set((data?.users ?? []).flatMap((u) => u.roles))).sort((a, b) => roleName(a).localeCompare(roleName(b))), [data])

  // Per-user figures for the range, filtered by role / centre / status.
  const rows = useMemo(() => {
    if (!data) return []
    const byUser = new Map<string, UsageRow[]>()
    for (const u of data.usage) byUser.set(u.user_id, [...(byUser.get(u.user_id) ?? []), u])
    const logins = new Map<string, number>()
    for (const l of data.logins) logins.set(l.user_id, (logins.get(l.user_id) ?? 0) + 1)
    return data.users
      .filter((u) => (showInactive || u.status !== 'inactive') && (!role || u.roles.includes(role)) && (!centre || u.centres.includes(centre)))
      .map((u) => {
        const us = byUser.get(u.id) ?? []
        const pages = new Map<string, number>()
        for (const r of us) pages.set(r.section, (pages.get(r.section) ?? 0) + r.hits)
        const lastSeen = us.reduce<string | null>((a, r) => (!a || r.last_at > a ? r.last_at : a), null)
        const actionTotal = Object.values(u.actions).reduce((a, b) => a + b, 0)
        return {
          ...u,
          activeDays: new Set(us.map((r) => r.day)).size,
          views: us.reduce((a, r) => a + r.hits, 0),
          logins: logins.get(u.id) ?? 0,
          lastSeen,
          actionTotal,
          pages: Array.from(pages.entries()).sort((a, b) => b[1] - a[1]),
          dayList: Array.from(new Set(us.map((r) => r.day))).sort(),
        }
      })
      .sort((a, b) => b.activeDays - a.activeDays || b.views - a.views || (b.lastSignIn ?? '').localeCompare(a.lastSignIn ?? '') || a.name.localeCompare(b.name))
  }, [data, role, centre, showInactive])

  const used = (r: (typeof rows)[number]) => r.activeDays > 0 || r.logins > 0 || r.actionTotal > 0
  const activeUsers = rows.filter(used).length
  const totals = useMemo(() => ({
    logins: rows.reduce((a, r) => a + r.logins, 0),
    userDays: rows.reduce((a, r) => a + r.activeDays, 0),
    views: rows.reduce((a, r) => a + r.views, 0),
    actions: rows.reduce((a, r) => a + r.actionTotal, 0),
  }), [rows])

  // Daily active users (within the filtered users).
  const daily = useMemo(() => {
    if (!data) return []
    const ids = new Set(rows.map((r) => r.id))
    const per = new Map<string, Set<string>>()
    for (const u of data.usage) if (ids.has(u.user_id)) per.set(u.day, (per.get(u.day) ?? new Set()).add(u.user_id))
    return days.map((d) => ({ d, n: per.get(d)?.size ?? 0 }))
  }, [data, rows, days])
  const peak = Math.max(1, ...daily.map((x) => x.n))

  const groupBy = (keyOf: (r: (typeof rows)[number]) => string[]) => {
    const m = new Map<string, { total: number; active: number; views: number; days: number }>()
    for (const r of rows) for (const k of keyOf(r).length ? keyOf(r) : ['—']) {
      const g = m.get(k) ?? { total: 0, active: 0, views: 0, days: 0 }
      g.total++; if (used(r)) g.active++; g.views += r.views; g.days += r.activeDays
      m.set(k, g)
    }
    return Array.from(m.entries()).sort((a, b) => b[1].total - a[1].total)
  }
  const byRole = useMemo(() => groupBy((r) => r.roles.map(roleName)), [rows]) // eslint-disable-line react-hooks/exhaustive-deps
  const byCentre = useMemo(() => groupBy((r) => r.centres), [rows]) // eslint-disable-line react-hooks/exhaustive-deps

  const downloadCsv = () => {
    if (!data) return
    const cell = (v: string | number | null | undefined) => { const t = v == null ? '' : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t }
    const lines: (string | number | null)[][] = [
      ['Superclass Portal — Usage Report'], ['Period', `${data.from} to ${data.to}`], ['Generated', fmtWhen(new Date().toISOString())],
      ['Tracking since', data.trackingSince ?? 'not started'], ['Users active', `${activeUsers} / ${rows.length}`],
      ['Sign-ins', totals.logins], ['Active user-days', totals.userDays], ['Page views', totals.views], ['Work recorded', totals.actions], [],
      ['Name', 'Email', 'Roles', 'Centres', 'Status', 'Last seen', 'Last password sign-in', 'Sign-ins', 'Active days', 'Days used', 'Page views', 'Work recorded', 'Work detail', 'Most used pages'],
      ...rows.map((r) => [r.name, r.email, r.roles.map(roleName).join(' / '), r.centres.join(' / '), r.status,
        fmtWhen(r.lastSeen), fmtWhen(r.lastSignIn), r.logins, r.activeDays, r.dayList.join(' '), r.views, r.actionTotal,
        Object.entries(r.actions).map(([k, v]) => `${k}: ${v}`).join('; '), r.pages.slice(0, 5).map(([p, n]) => `${pageName(p)} (${n})`).join('; ')]),
      [], ['DAILY ACTIVE USERS'], ['Date', 'Active users'], ...daily.map((x) => [x.d, x.n]),
    ]
    const blob = new Blob(['﻿' + lines.map((l) => l.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob); a.download = `Portal usage ${data.from} to ${data.to}.csv`; a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <div className="space-y-5">
      <PageHeader title="Usage Report" description="Who is using the portal — sign-ins, active days, pages opened and work recorded, per user, role and centre." />

      {err && <Alert type="error">{err}</Alert>}

      <Card className="p-4">
        <div className="flex flex-wrap gap-3 items-end">
          <div><label className={label}>From</label><input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className={field} /></div>
          <div><label className={label}>To</label><input type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} className={field} /></div>
          <div>
            <label className={label}>Role</label>
            <select value={role} onChange={(e) => setRole(e.target.value)} className={`${field} min-w-[150px]`}>
              <option value="">All roles</option>
              {roleOptions.map((r) => <option key={r} value={r}>{roleName(r)}</option>)}
            </select>
          </div>
          <div>
            <label className={label}>Centre</label>
            <select value={centre} onChange={(e) => setCentre(e.target.value)} className={`${field} min-w-[150px]`}>
              <option value="">All centres</option>
              {centreOptions.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <label className="flex items-center gap-2 h-9 text-sm text-neutral-600">
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Include inactive users
          </label>
          <BtnPrimary onClick={() => load(from, to)} disabled={loading || !from || !to || from > to}>{loading ? 'Loading…' : '↻ Refresh'}</BtnPrimary>
          <BtnSecondary onClick={downloadCsv} disabled={!data || loading}>⬇ Download CSV</BtnSecondary>
        </div>
        <div className="flex flex-wrap gap-2 mt-3 text-xs">
          {([[7, 'Last 7 days'], [30, 'Last 30 days'], ['month', 'This month'], [90, 'Last 90 days']] as const).map(([d, t]) => (
            <button key={t} onClick={() => preset(d)} className="px-2.5 py-1 rounded-lg border border-neutral-200 text-neutral-600 hover:bg-violet-50 hover:border-violet-200">{t}</button>
          ))}
        </div>
      </Card>

      {data && (
        <p className="text-xs text-neutral-500 -mt-2">
          {data.trackingSince
            ? <>Page-by-page tracking started on <b>{fmtDay(data.trackingSince)} {data.trackingSince.slice(0, 4)}</b>. Days before that show only the last password sign-in (from Supabase).</>
            : <>Page tracking has not recorded anything yet — it starts as soon as people open the portal after this update. Until then only the last password sign-in (from Supabase) is known.</>}
          {' '}People usually stay signed in, so <b>active days</b> is the truest measure of use; sign-ins only count typing the password.
        </p>
      )}

      {loading && !data && <Card className="p-10 text-center text-neutral-400">Loading report…</Card>}

      {data && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            {[
              { k: 'Users active', v: `${activeUsers} / ${rows.length}`, s: rows.length ? `${Math.round((activeUsers / rows.length) * 100)}% used the portal` : '' },
              { k: 'Active user-days', v: totals.userDays, s: 'a person using it on a day' },
              { k: 'Page views', v: totals.views, s: 'pages opened' },
              { k: 'Sign-ins', v: totals.logins, s: 'email + password' },
              { k: 'Work recorded', v: totals.actions, s: 'tests, requests, schedules…' },
            ].map((x) => (
              <Card key={x.k} className="p-4">
                <div className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">{x.k}</div>
                <div className="text-2xl font-black text-neutral-950 mt-1 tabular-nums">{x.v}</div>
                <div className="text-xs text-neutral-400 mt-0.5">{x.s}</div>
              </Card>
            ))}
          </div>

          <Card className="p-5">
            <div className="flex items-baseline justify-between mb-3">
              <h4 className="font-semibold text-neutral-950">Daily active users</h4>
              <span className="text-xs text-neutral-400">peak {Math.max(0, ...daily.map((x) => x.n))} · {fmtDay(data.from)} – {fmtDay(data.to)}</span>
            </div>
            <div className="flex items-end gap-[2px] h-36">
              {daily.map((x) => (
                <div key={x.d} className="flex-1 h-full flex flex-col justify-end group relative" title={`${fmtDay(x.d)}: ${x.n} user${x.n === 1 ? '' : 's'}`}>
                  <div className={`rounded-t ${x.n ? 'bg-violet-500 group-hover:bg-violet-600' : 'bg-neutral-100'}`} style={{ height: x.n ? `${Math.max(4, (x.n / peak) * 100)}%` : '2px' }} />
                </div>
              ))}
            </div>
            <div className="flex justify-between text-[10px] text-neutral-400 mt-1"><span>{fmtDay(data.from)}</span><span>{fmtDay(data.to)}</span></div>
          </Card>

          <div className="grid md:grid-cols-2 gap-4">
            {([['By role', byRole], ['By centre', byCentre]] as const).map(([title, list]) => (
              <Card key={title} className="overflow-hidden p-0">
                <div className="px-5 py-3 border-b border-neutral-100 font-semibold text-neutral-950">{title}</div>
                <table className="w-full text-sm">
                  <thead><tr className="bg-neutral-50 text-neutral-500 text-xs uppercase tracking-wider text-left">
                    <th className="px-5 py-2">{title === 'By role' ? 'Role' : 'Centre'}</th><th className="px-3 py-2">Active</th><th className="px-3 py-2">User-days</th><th className="px-3 py-2">Views</th>
                  </tr></thead>
                  <tbody className="divide-y divide-neutral-100">
                    {list.map(([k, g]) => (
                      <tr key={k}>
                        <td className="px-5 py-2 font-medium text-neutral-900">{k}</td>
                        <td className="px-3 py-2 tabular-nums">
                          {g.active}<span className="text-neutral-400">/{g.total}</span>
                          <span className={`ml-2 text-xs font-semibold ${g.active === g.total ? 'text-emerald-600' : g.active ? 'text-amber-600' : 'text-rose-600'}`}>{Math.round((g.active / g.total) * 100)}%</span>
                        </td>
                        <td className="px-3 py-2 tabular-nums">{g.days}</td>
                        <td className="px-3 py-2 tabular-nums">{g.views}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            ))}
          </div>

          <Card className="overflow-hidden p-0">
            <div className="px-5 py-3 border-b border-neutral-100 flex items-baseline justify-between">
              <span className="font-semibold text-neutral-950">Users ({rows.length})</span>
              <span className="text-xs text-neutral-400">Click a row for the pages used and days active</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[900px]">
                <thead><tr className="bg-neutral-50 text-neutral-500 text-xs uppercase tracking-wider text-left">
                  <th className="px-5 py-2">User</th><th className="px-3 py-2">Role</th><th className="px-3 py-2">Centre</th>
                  <th className="px-3 py-2">Last seen</th><th className="px-3 py-2">Last sign-in</th>
                  <th className="px-3 py-2">Active days</th><th className="px-3 py-2">Views</th><th className="px-3 py-2">Sign-ins</th><th className="px-3 py-2">Work</th>
                </tr></thead>
                <tbody className="divide-y divide-neutral-100">
                  {rows.map((r) => (
                    <Fragment key={r.id}>
                      <tr onClick={() => setOpen(open === r.id ? null : r.id)} className={`cursor-pointer hover:bg-neutral-50/70 ${used(r) ? '' : 'bg-rose-50/40'}`}>
                        <td className="px-5 py-2">
                          <div className="font-medium text-neutral-900">{r.name}{r.status === 'inactive' && <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-neutral-200 text-neutral-600">inactive</span>}</div>
                          <div className="text-xs text-neutral-400">{r.email}</div>
                        </td>
                        <td className="px-3 py-2 text-neutral-600">{r.roles.map(roleName).join(', ') || '—'}</td>
                        <td className="px-3 py-2 text-neutral-600">{r.centres.join(', ') || '—'}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{r.lastSeen ? fmtWhen(r.lastSeen) : <span className="text-rose-600 text-xs font-semibold">Not used in period</span>}</td>
                        <td className="px-3 py-2 whitespace-nowrap text-neutral-500">{r.lastSignIn ? fmtWhen(r.lastSignIn) : <span className="text-rose-600 text-xs font-semibold">Never</span>}</td>
                        <td className="px-3 py-2 tabular-nums font-semibold">{r.activeDays}<span className="text-neutral-400 font-normal">/{days.length}</span></td>
                        <td className="px-3 py-2 tabular-nums">{r.views}</td>
                        <td className="px-3 py-2 tabular-nums">{r.logins}</td>
                        <td className="px-3 py-2 tabular-nums">{r.actionTotal}</td>
                      </tr>
                      {open === r.id && (
                        <tr className="bg-violet-50/40">
                          <td colSpan={9} className="px-5 py-3 text-xs text-neutral-700">
                            <div className="grid md:grid-cols-3 gap-4">
                              <div>
                                <div className="font-semibold text-neutral-900 mb-1">Pages used</div>
                                {r.pages.length ? r.pages.slice(0, 12).map(([p, n]) => <div key={p} className="flex justify-between gap-3"><span>{pageName(p)}</span><span className="tabular-nums text-neutral-500">{n}</span></div>) : <span className="text-neutral-400">No pages opened in this period.</span>}
                              </div>
                              <div>
                                <div className="font-semibold text-neutral-900 mb-1">Days active</div>
                                {r.dayList.length ? <div className="flex flex-wrap gap-1">{r.dayList.map((d) => <span key={d} className="px-1.5 py-0.5 rounded bg-white border border-violet-100">{fmtDay(d)}</span>)}</div> : <span className="text-neutral-400">None</span>}
                              </div>
                              <div>
                                <div className="font-semibold text-neutral-900 mb-1">Work recorded</div>
                                {Object.keys(r.actions).length ? Object.entries(r.actions).map(([k, v]) => <div key={k} className="flex justify-between gap-3"><span>{k}</span><span className="tabular-nums text-neutral-500">{v}</span></div>) : <span className="text-neutral-400">None in this period.</span>}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  )
}
