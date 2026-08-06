import { NextResponse } from 'next/server'
import { ingestAudit } from '@/lib/audit-ingest'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

// Ingest a CCTV audit run pushed by the fleet control server.
// Auth mirrors the other internal endpoints: Bearer <secret>. Uses a
// dedicated AUDIT_INGEST_SECRET if set, else falls back to CRON_SECRET.
export async function POST(request: Request) {
  const secret = process.env.AUDIT_INGEST_SECRET || process.env.CRON_SECRET
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const payload = await request.json()
    const summary = await ingestAudit({
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      payload,
    })
    return NextResponse.json({ ok: true, ...summary })
  } catch (error) {
    console.error('Audit ingest failed', error)
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Audit ingest failed.' },
      { status: 500 },
    )
  }
}
