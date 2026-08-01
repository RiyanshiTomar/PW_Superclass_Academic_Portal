import { NextResponse } from 'next/server'
import { syncAttendance } from '@/lib/attendance-sync'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const rawAccount = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
    if (!rawAccount) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not configured.')
    const summary = await syncAttendance({
      serviceAccount: JSON.parse(rawAccount),
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      sheetId: process.env.ATTENDANCE_SHEET_ID || undefined,
      tab: process.env.ATTENDANCE_SHEET_TAB || '',
    })
    return NextResponse.json({ ok: true, ...summary })
  } catch (error) {
    console.error('Scheduled attendance sync failed', error)
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : 'Attendance sync failed.' }, { status: 500 })
  }
}
