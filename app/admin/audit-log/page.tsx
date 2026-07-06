'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

type LogEntry = {
  id: string
  action: string
  entity_type: string
  created_at: string
  app_users: { full_name: string } | null
}

export default function AuditLogPage() {
  const supabase = createClient()
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const load = async () => {
      const { data } = await supabase
        .from('audit_log')
        .select('id, action, entity_type, created_at, app_users(full_name)')
        .order('created_at', { ascending: false })
        .limit(100)

      if (data) setLogs(data as unknown as LogEntry[])
      setLoading(false)
    }
    load()
  }, [])

  return (
    <div className="max-w-4xl">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-gray-900">Audit Log</h1>
        <p className="text-sm text-gray-500">Recent system activity (last 100 events).</p>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-gray-400 text-sm">Loading...</div>
        ) : logs.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">
            No activity logged yet. Activity will appear here as actions are taken across the
            platform.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-gray-500 text-xs">
                <th className="text-left px-4 py-2.5 font-medium">User</th>
                <th className="text-left px-4 py-2.5 font-medium">Action</th>
                <th className="text-left px-4 py-2.5 font-medium">Entity</th>
                <th className="text-left px-4 py-2.5 font-medium">Time</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id} className="border-t border-gray-100">
                  <td className="px-4 py-3 text-gray-900">{log.app_users?.full_name || 'System'}</td>
                  <td className="px-4 py-3 text-gray-600">{log.action}</td>
                  <td className="px-4 py-3 text-gray-600">{log.entity_type}</td>
                  <td className="px-4 py-3 text-gray-400 text-xs">
                    {new Date(log.created_at).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}