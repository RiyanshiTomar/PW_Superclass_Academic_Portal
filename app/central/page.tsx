'use client'

import { useState } from 'react'
import BatchScheduler from '@/components/central/BatchScheduler'
import BatchPlannerPanel from '@/components/central/BatchPlannerPanel'

type View = 'scheduler' | 'planner'

const CLICKERS: { key: View; label: string; desc: string }[] = [
  { key: 'scheduler', label: 'Batch Scheduler', desc: 'Batches & weekly faculty timetable' },
  { key: 'planner', label: 'Batch Planner', desc: 'Create · Assign · Edit planners' },
]

export default function CentralHub() {
  const [view, setView] = useState<View>('scheduler')

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4 mb-8">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-gradient">Central Team</h1>
          <p className="text-sm text-neutral-500 mt-1.5 max-w-xl">
            Manage batches and lecture planners across all centres. Pick a workspace on the right.
          </p>
        </div>
        <div className="flex gap-3 shrink-0">
          {CLICKERS.map((c, i) => {
            const active = view === c.key
            return (
              <button
                key={c.key}
                onClick={() => setView(c.key)}
                style={{ animationDelay: `${i * 80}ms` }}
                className={`animate-fade-up hover-lift text-left rounded-2xl border px-4 py-3 min-w-[180px] ${
                  active
                    ? 'border-transparent bg-gradient-to-r from-violet-600 to-indigo-600 text-white shadow-lg shadow-violet-500/30'
                    : 'border-neutral-200 bg-white/90 text-neutral-700 hover:border-violet-300 hover:shadow-md'
                }`}
              >
                <div className="font-semibold text-sm">{c.label}</div>
                <div className={`text-xs mt-0.5 ${active ? 'text-violet-100' : 'text-neutral-500'}`}>{c.desc}</div>
              </button>
            )
          })}
        </div>
      </div>

      {view === 'scheduler' ? <BatchScheduler /> : <BatchPlannerPanel />}
    </div>
  )
}
