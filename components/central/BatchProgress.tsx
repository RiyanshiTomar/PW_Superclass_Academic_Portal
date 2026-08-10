'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getBatchProgress, type BatchProgressData } from '@/lib/tests'
import { getUserCentreIds, getAppUser } from '@/lib/auth'
import { Alert, Card, PageHeader } from '@/components/PortalShell'

type Batch = {
  id: string
  name: string
  centre_id: string
  start_date: string
  end_date: string
  centres: { name: string }[] | { name: string } | null
}

export default function BatchProgress() {
  const supabase = createClient()
  const [batches, setBatches] = useState<Batch[]>([])
  const [progressData, setProgressData] = useState<Record<string, BatchProgressData>>({})
  const [loading, setLoading] = useState(true)
  const [selectedCentreId, setSelectedCentreId] = useState('')
  const [centres, setCentres] = useState<{ id: string; name: string }[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    loadData()
  }, [])

  const loadData = async () => {
    setLoading(true)
    setError(null)
    
    try {
      // Get user's accessible centres
      const { data: { user } } = await supabase.auth.getUser()
      const appUser = user ? await getAppUser(supabase, user) : null
      const centreIds = getUserCentreIds(appUser)

      // Get centres
      let centreQuery = supabase.from('centres').select('id, name').order('name')
      if (centreIds.length > 0) {
        centreQuery = centreQuery.in('id', centreIds)
      }
      const { data: centresData } = await centreQuery
      const centresList = (centresData ?? []) as { id: string; name: string }[]
      setCentres(centresList)

      // Get batches
      let batchQuery = supabase
        .from('batches')
        .select('id, name, centre_id, start_date, end_date, centres(name)')
        .order('start_date', { ascending: false })
      
      if (centreIds.length > 0) {
        batchQuery = batchQuery.in('centre_id', centreIds)
      }
      
      const { data: batchData } = await batchQuery
      const batchList = (batchData ?? []) as unknown as Batch[]
      setBatches(batchList)

      // Load progress for all batches
      const progressPromises = batchList.map(async (batch) => {
        try {
          const progress = await getBatchProgress(supabase, batch.id)
          return { batchId: batch.id, progress }
        } catch (err) {
          console.error(`Failed to load progress for batch ${batch.id}:`, err)
          return null
        }
      })

      const progressResults = await Promise.all(progressPromises)
      const progressMap: Record<string, BatchProgressData> = {}
      
      progressResults.forEach(result => {
        if (result) {
          progressMap[result.batchId] = result.progress
        }
      })
      
      setProgressData(progressMap)
    } catch (err) {
      console.error('Failed to load batch progress:', err)
      setError('Failed to load batch progress data')
    } finally {
      setLoading(false)
    }
  }

  const filteredBatches = selectedCentreId 
    ? batches.filter(b => b.centre_id === selectedCentreId)
    : batches

  const getStatusColor = (status: BatchProgressData['status']) => {
    switch (status) {
      case 'on_track': return 'text-emerald-600 bg-emerald-50 border-emerald-200'
      case 'ahead': return 'text-blue-600 bg-blue-50 border-blue-200'  
      case 'behind': return 'text-amber-600 bg-amber-50 border-amber-200'
      case 'critically_behind': return 'text-red-600 bg-red-50 border-red-200'
      default: return 'text-neutral-600 bg-neutral-50 border-neutral-200'
    }
  }

  if (loading) {
    return (
      <div>
        <PageHeader 
          title="Batch Progress Tracking" 
          description="Monitor schedule adherence, completion rates, and buffer utilization across all batches"
        />
        <Card className="p-8 text-center text-neutral-400">Loading batch progress...</Card>
      </div>
    )
  }

  return (
    <div>
      <PageHeader 
        title="Batch Progress Tracking" 
        description="Monitor schedule adherence, lecture completion, and buffer utilization. Red alerts indicate batches falling behind schedule."
      />

      {error && <Alert type="error">{error}</Alert>}

      <div className="flex gap-3 mb-6">
        <select 
          value={selectedCentreId} 
          onChange={(e) => setSelectedCentreId(e.target.value)}
          className="h-10 px-3 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
        >
          <option value="">All Centres</option>
          {centres.map(c => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>

      {filteredBatches.length === 0 ? (
        <Card className="p-8 text-center text-neutral-400">
          No batches found {selectedCentreId && 'at selected centre'}
        </Card>
      ) : (
        <div className="grid gap-4">
          {filteredBatches.map((batch) => {
            const progress = progressData[batch.id]
            if (!progress) {
              return (
                <Card key={batch.id} className="p-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="font-semibold text-neutral-900">{batch.name}</h3>
                      <p className="text-sm text-neutral-500">
                        {Array.isArray(batch.centres) ? batch.centres[0]?.name : batch.centres?.name}
                      </p>
                    </div>
                    <span className="text-sm text-neutral-400">Progress data unavailable</span>
                  </div>
                </Card>
              )
            }

            return (
              <Card key={batch.id} className="p-6">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h3 className="font-semibold text-neutral-900 text-lg">{batch.name}</h3>
                    <p className="text-sm text-neutral-500">
                      {Array.isArray(batch.centres) ? batch.centres[0]?.name : batch.centres?.name} • {progress.startDate} to {progress.endDate}
                    </p>
                  </div>
                  <div className={`px-3 py-1 rounded-full text-sm font-medium border ${getStatusColor(progress.status)}`}>
                    {progress.status.replace('_', ' ').toUpperCase()}
                  </div>
                </div>

                {/* Status Message */}
                <div className="mb-4">
                  <p className="text-sm font-medium text-neutral-800">{progress.statusMessage}</p>
                </div>

                {/* Progress Metrics Grid */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                  {/* Time Progress */}
                  <div className="bg-neutral-50 rounded-lg p-3">
                    <div className="text-xs text-neutral-500 mb-1">Time Progress</div>
                    <div className="font-semibold text-lg text-neutral-900">{progress.progressPercentage}%</div>
                    <div className="text-xs text-neutral-600">{progress.elapsedDays} / {progress.totalDays} days</div>
                  </div>

                  {/* Lecture Completion */}
                  <div className="bg-blue-50 rounded-lg p-3">
                    <div className="text-xs text-blue-600 mb-1">Lectures Done</div>
                    <div className="font-semibold text-lg text-blue-900">{progress.completionPercentage}%</div>
                    <div className="text-xs text-blue-700">{progress.lecturesCompleted} / {progress.totalLecturesPlanned} total</div>
                  </div>

                  {/* Expected vs Actual */}
                  <div className={`rounded-lg p-3 ${progress.lecturesCompleted >= progress.lecturesExpected ? 'bg-emerald-50' : 'bg-red-50'}`}>
                    <div className={`text-xs mb-1 ${progress.lecturesCompleted >= progress.lecturesExpected ? 'text-emerald-600' : 'text-red-600'}`}>
                      Expected vs Actual
                    </div>
                    <div className={`font-semibold text-lg ${progress.lecturesCompleted >= progress.lecturesExpected ? 'text-emerald-900' : 'text-red-900'}`}>
                      {progress.lecturesCompleted} / {progress.lecturesExpected}
                    </div>
                    <div className={`text-xs ${progress.lecturesCompleted >= progress.lecturesExpected ? 'text-emerald-700' : 'text-red-700'}`}>
                      {progress.lecturesCompleted >= progress.lecturesExpected ? 'On track' : `${progress.lecturesExpected - progress.lecturesCompleted} behind`}
                    </div>
                  </div>

                  {/* Buffer Usage */}
                  <div className={`rounded-lg p-3 ${progress.bufferUtilizationPercentage > 75 ? 'bg-amber-50' : 'bg-neutral-50'}`}>
                    <div className={`text-xs mb-1 ${progress.bufferUtilizationPercentage > 75 ? 'text-amber-600' : 'text-neutral-500'}`}>
                      Buffer Usage
                    </div>
                    <div className={`font-semibold text-lg ${progress.bufferUtilizationPercentage > 75 ? 'text-amber-900' : 'text-neutral-900'}`}>
                      {progress.bufferUtilizationPercentage}%
                    </div>
                    <div className={`text-xs ${progress.bufferUtilizationPercentage > 75 ? 'text-amber-700' : 'text-neutral-600'}`}>
                      {progress.bufferSlotsRemaining} / {progress.totalBufferSlots} left
                    </div>
                  </div>
                </div>

                {/* Recommendations */}
                {progress.recommendations.length > 0 && (
                  <div className="mb-4">
                    <h4 className="text-sm font-semibold text-neutral-700 mb-2">Recommendations:</h4>
                    <ul className="space-y-1">
                      {progress.recommendations.map((rec, idx) => (
                        <li key={idx} className="text-sm text-neutral-600 flex items-start gap-2">
                          <span className="text-violet-500 mt-0.5">•</span>
                          <span>{rec}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Subject Progress */}
                {progress.subjectProgress.length > 0 && (
                  <details className="mt-4">
                    <summary className="cursor-pointer text-sm font-semibold text-neutral-700 hover:text-neutral-900">
                      Subject-wise Progress ({progress.subjectProgress.length} subjects)
                    </summary>
                    <div className="mt-3 grid gap-2">
                      {progress.subjectProgress.map(subject => (
                        <div key={subject.subjectId} className={`p-3 rounded-lg border ${subject.isOnTrack ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200'}`}>
                          <div className="flex items-center justify-between">
                            <span className="font-medium text-sm text-neutral-900">{subject.subjectName}</span>
                            <span className={`text-xs font-semibold ${subject.isOnTrack ? 'text-emerald-700' : 'text-red-700'}`}>
                              {subject.isOnTrack ? '✓' : '⚠'} {subject.completedLectures}/{subject.expectedLectures}
                            </span>
                          </div>
                          <div className="text-xs text-neutral-600 mt-1">
                            {subject.completedLectures} of {subject.plannedLectures} lectures completed ({Math.round(subject.completionRate)}%)
                          </div>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}