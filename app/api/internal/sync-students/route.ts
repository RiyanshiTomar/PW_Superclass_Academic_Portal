import { NextResponse } from 'next/server'
import { syncStudents } from '@/lib/student-sync'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const rawAccount = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
    if (!rawAccount) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not configured.')
    const summary = await syncStudents({ serviceAccount: JSON.parse(rawAccount), supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL, serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY, sheetId: process.env.STUDENTS_SHEET_ID })
    return NextResponse.json({ ok: true, ...summary })
  } catch (error) {
    console.error('Scheduled student sync failed', error)
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : 'Student sync failed.' }, { status: 500 })
  }
}
