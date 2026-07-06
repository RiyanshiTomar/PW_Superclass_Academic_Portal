'use client'

import { useState } from 'react'
import { PageHeader } from '@/components/PortalShell'
import CreatePlanner from './CreatePlanner'
import AssignPlanner from './AssignPlanner'
import EditPlanner from './EditPlanner'

type Tab = 'create' | 'assign' | 'edit'

const TABS: { key: Tab; label: string; hint: string }[] = [
  { key: 'create', label: 'Create Planner', hint: 'Upload a CSV → a reusable planner' },
  { key: 'assign', label: 'Assign Planner', hint: 'Link to batch + faculty, drive stages' },
  { key: 'edit', label: 'Edit Planner', hint: 'Change lectures, re-materialise drafts' },
]

export default function BatchPlannerPanel() {
  const [tab, setTab] = useState<Tab>('create')

  return (
    <div>
      <PageHeader
        title="Batch Planner"
        description="Create a planner once, assign it to one or many batches with a faculty, and edit it any time."
      />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-8">
        {TABS.map((t, i) => {
          const active = tab === t.key
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              style={{ animationDelay: `${i * 70}ms` }}
              className={`animate-fade-up hover-lift text-left rounded-2xl border p-4 ${
                active
                  ? 'border-transparent bg-gradient-to-r from-violet-600 to-indigo-600 text-white shadow-lg shadow-violet-500/30'
                  : 'border-neutral-200 bg-white/90 text-neutral-700 hover:border-violet-300 hover:shadow-md'
              }`}
            >
              <div className="font-semibold">{t.label}</div>
              <div className={`text-xs mt-0.5 ${active ? 'text-violet-100' : 'text-neutral-500'}`}>{t.hint}</div>
            </button>
          )
        })}
      </div>

      {tab === 'create' && <CreatePlanner />}
      {tab === 'assign' && <AssignPlanner />}
      {tab === 'edit' && <EditPlanner />}
    </div>
  )
}
