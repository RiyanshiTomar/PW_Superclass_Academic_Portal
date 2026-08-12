'use client'

import { useState, useEffect, useMemo } from 'react'
import { Card, Alert, BtnSecondary as Button } from '@/components/PortalShell'
import { createClient } from '@/lib/supabase/client'

type Batch = {
  id: string
  name: string
  start_date: string
  end_date: string
  program_id: string
  centre_id: string
}

type Program = {
  id: string
  name: string
}

type Centre = {
  id: string
  name: string
  branch_head_id?: string
}

type Faculty = {
  id: string
  full_name: string
  faculty_type?: string
}

type Schedule = {
  id: string
  batch_id: string
  subject_id: string
  faculty_id: string
  day_of_week: string | number
  start_time: string
  end_time: string
  subject_name?: string | null
  faculty_name?: string | null
}

type DatePhase = {
  phase: number
  startDate: string
  endDate: string
  schedules: Schedule[]
}

export default function FacultyScheduleView() {
  const supabase = createClient()
  
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  
  // Data states
  const [batches, setBatches] = useState<Batch[]>([])
  const [programs, setPrograms] = useState<Program[]>([])
  const [centres, setCentres] = useState<Centre[]>([])
  const [faculty, setFaculty] = useState<Faculty[]>([])
  const [appUser, setAppUser] = useState<any>(null)
  const [userCentres, setUserCentres] = useState<any[]>([])
  
  // Selection states
  const [selectedCentre, setSelectedCentre] = useState<string>('')
  const [selectedBatch1, setSelectedBatch1] = useState<string>('')
  const [selectedBatch2, setSelectedBatch2] = useState<string>('')
  
  // View states
  const [batch1Phases, setBatch1Phases] = useState<DatePhase[]>([])
  const [batch2Phases, setBatch2Phases] = useState<DatePhase[]>([])
  const [selectedSchedule, setSelectedSchedule] = useState<Schedule | null>(null)
  const [showScheduleModal, setShowScheduleModal] = useState(false)

  const loadData = async () => {
    setLoading(true)
    setMessage(null)
    
    try {
      // Get current user info first
      const { data: { user } } = await supabase.auth.getUser()
      
      if (user) {
        const { data: userData } = await supabase
          .from('app_users')
          .select('*')
          .eq('email', user.email?.toLowerCase())
          .single()
        setAppUser(userData)
      }
      
      const [batchesRes, programsRes, centresRes, ucRes] = await Promise.all([
        supabase.from('batches').select('*').order('created_at', { ascending: false }),
        supabase.from('programs').select('*').order('name'),
        supabase.from('centres').select('*').order('name'),
        supabase.from('user_centres').select('user_id, centre_id')
      ])
      
      // Try faculty RPC separately with error handling
      let facultyRes
      try {
        facultyRes = await supabase.rpc('list_active_faculty', { p_centre_id: null })
      } catch (err) {
        // Fallback to regular query
        facultyRes = await supabase
          .from('app_users')
          .select('id, full_name, email')
          .or('role.eq.faculty,roles.cs.{faculty}')
          .eq('status', 'active')
      }
      
      if (batchesRes.error) {
        setMessage({ type: 'error', text: batchesRes.error.message })
      }
      if (facultyRes.error) {
        setMessage({ type: 'error', text: 'Failed to load faculty data' })
      }
      
      if (batchesRes.data) setBatches(batchesRes.data)
      if (programsRes.data) setPrograms(programsRes.data)
      if (centresRes.data) setCentres(centresRes.data)
      if (facultyRes.data) setFaculty(facultyRes.data as Faculty[])
      if (ucRes.data) setUserCentres(ucRes.data)
      
    } catch (error) {
      setMessage({ type: 'error', text: `Failed to load data: ${error}` })
    }
    
    setLoading(false)
  }

  useEffect(() => {
    loadData()
  }, [])

  const loadBatchSchedule = async (batchId: string): Promise<DatePhase[]> => {
    if (!batchId) return []
    
    const batch = batches.find(b => b.id === batchId)
    if (!batch) return []
    
    // Get batch schedules with subject and faculty info
    const { data: schedules, error } = await supabase
      .from('batch_schedules')
      .select(`
        *,
        subjects(name),
        app_users!batch_schedules_faculty_id_fkey(full_name)
      `)
      .eq('batch_id', batchId)
    
    if (error) {
      setMessage({ type: 'error', text: `Failed to load schedules: ${error.message}` })
    }
    
    if (!schedules || schedules.length === 0) {
      // Still create empty phase to show batch structure
      return [{
        phase: 1,
        startDate: batch.start_date,
        endDate: batch.end_date,
        schedules: []
      }]
    }

    // Group schedules by different date ranges to create phases
    // This will detect if there are multiple schedule periods
    const schedulesByDateRange = new Map<string, any[]>()
    
    schedules.forEach(s => {
      // Check if schedule has date_range or create default range
      const dateRangeKey = s.date_range || `${batch.start_date}_${batch.end_date}`
      if (!schedulesByDateRange.has(dateRangeKey)) {
        schedulesByDateRange.set(dateRangeKey, [])
      }
      schedulesByDateRange.get(dateRangeKey)!.push(s)
    })

    // Create phases from different date ranges
    const phases: DatePhase[] = []
    let phaseNumber = 1
    
    for (const [dateRange, phaseSchedules] of schedulesByDateRange) {
      const [startDate, endDate] = dateRange.includes('_') ? dateRange.split('_') : [batch.start_date, batch.end_date]
      
      phases.push({
        phase: phaseNumber++,
        startDate,
        endDate,
        schedules: phaseSchedules.map(s => ({
          id: s.id,
          batch_id: s.batch_id,
          subject_id: s.subject_id,
          faculty_id: s.faculty_id,
          day_of_week: s.day_of_week, // Keep original numeric value
          start_time: s.start_time || '',
          end_time: s.end_time || '',
          subject_name: s.subjects?.name || 'Unknown Subject',
          faculty_name: s.app_users?.full_name || 'Unknown Faculty'
        })) // Include ALL schedules, don't filter out based on day_of_week
      })
    }
    
    return phases
  }

  // Filter centres based on user permissions
  const accessibleCentres = useMemo(() => {
    if (!appUser) return []
    
    // Admin can see all centres
    if (appUser.role === 'admin' || (appUser.roles && appUser.roles.includes('admin'))) {
      return centres
    }
    
    // Central team can see all centres 
    if (appUser.role === 'central_team' || (appUser.roles && appUser.roles.includes('central_team'))) {
      return centres
    }
    
    // Branch head can see centres they manage + their user centres
    const userCentreIds = new Set(userCentres.filter(uc => uc.user_id === appUser.id).map(uc => uc.centre_id))
    const branchHeadCentres = centres.filter(c => c.branch_head_id === appUser.id)
    branchHeadCentres.forEach(c => userCentreIds.add(c.id))
    
    return centres.filter(c => userCentreIds.has(c.id))
  }, [appUser, centres, userCentres])
  
  // Filter batches based on selected centre
  const filteredBatches = useMemo(() => {
    if (!selectedCentre) return []
    return batches.filter(batch => batch.centre_id === selectedCentre)
  }, [batches, selectedCentre])

  const handleCentreChange = (centreId: string) => {
    setSelectedCentre(centreId)
    setSelectedBatch1('')
    setSelectedBatch2('')
    setBatch1Phases([])
    setBatch2Phases([])
  }

  const handleBatch1Change = async (batchId: string) => {
    setSelectedBatch1(batchId)
    const phases = await loadBatchSchedule(batchId)
    setBatch1Phases(phases)
  }

  const handleBatch2Change = async (batchId: string) => {
    setSelectedBatch2(batchId)
    const phases = await loadBatchSchedule(batchId)
    setBatch2Phases(phases)
  }

  const generateWeeklyTemplate = (phase: DatePhase) => {
    // Helper function to safely get day name
    const getDayName = (dayOfWeek: any): string => {
      // Handle null, undefined, empty string
      if (dayOfWeek === null || dayOfWeek === undefined || dayOfWeek === '') {
        return ''
      }
      
      // Handle numeric day (0=Sunday, 1=Monday, etc.) - DATABASE FORMAT
      if (typeof dayOfWeek === 'number') {
        const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
        return days[dayOfWeek] || ''
      }
      
      // Convert to number if it's a string number
      const numericDay = Number(dayOfWeek)
      if (!isNaN(numericDay) && numericDay >= 0 && numericDay <= 6) {
        const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
        return days[numericDay] || ''
      }
      
      // Handle string representation
      let day = String(dayOfWeek).toLowerCase().trim()
      
      // Comprehensive day matching (support multiple formats)
      if (day === 'sunday' || day === 'sun' || day === '0') return 'sunday'
      if (day === 'monday' || day === 'mon' || day === '1') return 'monday'
      if (day === 'tuesday' || day === 'tue' || day === '2') return 'tuesday'
      if (day === 'wednesday' || day === 'wed' || day === '3') return 'wednesday'
      if (day === 'thursday' || day === 'thu' || day === '4') return 'thursday'
      if (day === 'friday' || day === 'fri' || day === '5') return 'friday'
      if (day === 'saturday' || day === 'sat' || day === '6') return 'saturday'
      
      return ''
    }

    // Create weekly template showing what happens each day of the week
    // NOTE: Sunday is day 0 in database, so put it first
    const weeklyTemplate = {
      sunday: phase.schedules.filter(s => getDayName(s.day_of_week) === 'sunday'),
      monday: phase.schedules.filter(s => getDayName(s.day_of_week) === 'monday'),
      tuesday: phase.schedules.filter(s => getDayName(s.day_of_week) === 'tuesday'),
      wednesday: phase.schedules.filter(s => getDayName(s.day_of_week) === 'wednesday'),
      thursday: phase.schedules.filter(s => getDayName(s.day_of_week) === 'thursday'),
      friday: phase.schedules.filter(s => getDayName(s.day_of_week) === 'friday'),
      saturday: phase.schedules.filter(s => getDayName(s.day_of_week) === 'saturday')
    }
    
    return weeklyTemplate
  }

  const renderPhaseView = (phases: DatePhase[], batchId: string) => {
    const batch = batches.find(b => b.id === batchId)
    const program = programs.find(p => p.id === batch?.program_id)
    
    if (!batch) {
      return (
        <div className="h-full flex items-center justify-center text-neutral-400 p-4">
          <div className="text-center">
            <p className="text-sm sm:text-base">
              {selectedCentre ? 'Select a batch to view schedule' : 'Select a centre first'}
            </p>
          </div>
        </div>
      )
    }
    
    return (
      <div className="h-full overflow-y-auto">
        <div className="p-3 sm:p-4 border-b border-neutral-200 bg-neutral-50">
          <h3 className="font-bold text-neutral-900 text-sm sm:text-base">{batch.name}</h3>
          <p className="text-xs sm:text-sm text-neutral-600">{program?.name}</p>
          <p className="text-xs text-neutral-400">
            {new Date(batch.start_date).toLocaleDateString()} - {new Date(batch.end_date).toLocaleDateString()}
          </p>
        </div>
        
        <div className="p-2 sm:p-4 space-y-4 sm:space-y-6">
          {phases.map((phase) => {
            const weeklyTemplate = generateWeeklyTemplate(phase)
            return (
              <div key={phase.phase} className="space-y-3 sm:space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                  <div className="bg-blue-100 text-blue-800 px-2 sm:px-3 py-1 rounded-full text-xs sm:text-sm font-medium w-fit">
                    Phase {phase.phase}
                  </div>
                  <span className="text-xs sm:text-sm text-neutral-600">
                    {new Date(phase.startDate).toLocaleDateString()} - {new Date(phase.endDate).toLocaleDateString()}
                  </span>
                </div>
                
                {/* Weekly Schedule Template */}
                <Card className="p-3 sm:p-4">
                  <h4 className="font-medium text-neutral-900 mb-3 sm:mb-4 text-sm sm:text-base">
                    <span className="hidden sm:inline">Weekly Schedule (Repeats every week in this phase)</span>
                    <span className="sm:hidden">Weekly Schedule</span>
                  </h4>
                  
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-7 gap-2 md:gap-3">
                    {Object.entries(weeklyTemplate).map(([dayKey, daySchedules]) => {
                      const dayNames = {
                        sunday: 'Sunday',
                        monday: 'Monday',
                        tuesday: 'Tuesday', 
                        wednesday: 'Wednesday',
                        thursday: 'Thursday',
                        friday: 'Friday',
                        saturday: 'Saturday'
                      }
                      
                      return (
                        <div key={dayKey} className="min-h-[120px] w-full">
                          <div className="text-xs sm:text-sm font-semibold text-neutral-700 mb-2 md:mb-3 text-center border-b pb-1 md:pb-2">
                            <span className="hidden sm:inline">{dayNames[dayKey as keyof typeof dayNames]}</span>
                            <span className="sm:hidden">{dayNames[dayKey as keyof typeof dayNames].slice(0, 3)}</span>
                          </div>
                          <div className="space-y-2">
                            {daySchedules.length === 0 ? (
                              <div className="text-xs text-neutral-400 text-center py-1 md:py-2">
                                <span className="hidden sm:inline">No classes</span>
                                <span className="sm:hidden">-</span>
                              </div>
                            ) : (
                              daySchedules.map((schedule, idx) => {
                                const facultyInfo = faculty.find(f => f.id === schedule.faculty_id)
                                const facultyType = facultyInfo?.faculty_type || 'Unknown'
                                
                                // Better badge mapping - handle actual database values
                                const getBadgeInfo = (type: string) => {
                                  const lowerType = type.toLowerCase()
                                  if (lowerType.includes('permanent')) return { short: 'PERM', color: 'bg-green-600', label: 'Permanent Faculty' }
                                  if (lowerType.includes('hourly') || lowerType.includes('contract')) return { short: 'HRLY', color: 'bg-orange-500', label: 'Hourly/Contract Faculty' }
                                  return { short: 'UNK', color: 'bg-gray-500', label: 'Unknown Type' }
                                }
                                
                                const badge = getBadgeInfo(facultyType)
                                
                                return (
                                  <div
                                    key={idx}
                                    className="text-xs p-1.5 sm:p-2 md:p-2.5 bg-blue-50 border border-blue-200 rounded-md md:rounded-lg text-blue-800 hover:bg-blue-100 cursor-pointer transition-colors"
                                    title={`Click to expand details\n${schedule.subject_name || 'Unknown Subject'} - ${schedule.faculty_name || 'Unknown Faculty'}\nType: ${badge.label}\nTime: ${schedule.start_time} - ${schedule.end_time}`}
                                    onClick={() => {
                                      setSelectedSchedule(schedule)
                                      setShowScheduleModal(true)
                                    }}
                                  >
                                    <div className="flex items-center justify-between mb-1 sm:mb-1.5">
                                      <div className="font-bold truncate flex-1 text-blue-900 text-xs sm:text-sm">
                                        <span className="hidden sm:inline">{schedule.subject_name || 'Unknown Subject'}</span>
                                        <span className="sm:hidden">{(schedule.subject_name || 'Unknown').length > 8 ? (schedule.subject_name || 'Unknown').slice(0, 8) + '...' : (schedule.subject_name || 'Unknown')}</span>
                                      </div>
                                      <span className={`text-[8px] sm:text-[9px] px-1 sm:px-1.5 py-0.5 rounded text-white font-bold ml-1 ${badge.color}`}>
                                        <span className="hidden sm:inline">{badge.short}</span>
                                        <span className="sm:hidden">{badge.short.slice(0, 2)}</span>
                                      </span>
                                    </div>
                                    <div className="truncate text-blue-700 font-semibold mb-1 text-xs sm:text-sm">
                                      <span className="hidden md:inline">{schedule.faculty_name || 'Unknown Faculty'}</span>
                                      <span className="md:hidden">
                                        {(schedule.faculty_name || 'Unknown').length > 10 ? (schedule.faculty_name || 'Unknown').slice(0, 10) + '...' : (schedule.faculty_name || 'Unknown')}
                                      </span>
                                    </div>
                                    <div className="text-blue-600 font-bold text-center bg-blue-200 rounded px-1 py-0.5 text-xs">
                                      <span className="hidden sm:inline">{schedule.start_time} - {schedule.end_time}</span>
                                      <span className="sm:hidden">{schedule.start_time}</span>
                                    </div>
                                    <div className="text-[9px] sm:text-[10px] text-blue-500 text-center mt-1 opacity-75 hidden sm:block">
                                      Click for details
                                    </div>
                                  </div>
                                )
                              })
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </Card>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p className="text-neutral-500">Loading faculty schedule data...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="h-screen flex flex-col">
      {/* Header */}
      <div className="p-2 md:p-4 border-b border-neutral-200 bg-white">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-2">
          <div>
            <h1 className="text-lg md:text-2xl font-bold text-neutral-900">Faculty Schedule Overview</h1>
            <p className="text-xs md:text-sm text-neutral-600">Compare batch schedules and faculty workload week-wise</p>
          </div>
          <Button onClick={loadData} className="text-xs md:text-sm">
            Refresh Data
          </Button>
        </div>
        
        {message && (
          <div className="mt-4">
            <Alert type={message.type}>
              {message.text}
            </Alert>
          </div>
        )}
      </div>

      {/* Centre and Batch Selection */}
      <div className="p-2 md:p-4 bg-neutral-50 border-b border-neutral-200">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2 md:gap-4">
          <div>
            <label className="block text-xs md:text-sm font-medium text-neutral-700 mb-1 md:mb-2">
              Centre
            </label>
            <select 
              value={selectedCentre} 
              onChange={(e) => handleCentreChange(e.target.value)}
              className="w-full px-2 py-1.5 md:px-3 md:py-2 text-xs md:text-sm border border-neutral-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">Select Centre First</option>
              {accessibleCentres.map((centre) => (
                <option key={centre.id} value={centre.id}>
                  {centre.name}
                </option>
              ))}
            </select>
          </div>
          
          <div>
            <label className="block text-xs md:text-sm font-medium text-neutral-700 mb-1 md:mb-2">
              Batch 1 (Left Panel)
            </label>
            <select 
              value={selectedBatch1} 
              onChange={(e) => handleBatch1Change(e.target.value)}
              className="w-full px-2 py-1.5 md:px-3 md:py-2 text-xs md:text-sm border border-neutral-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={!selectedCentre}
            >
              <option value="">Select first batch to compare</option>
              {filteredBatches.map((batch) => {
                const program = programs.find(p => p.id === batch.program_id)
                return (
                  <option key={batch.id} value={batch.id}>
                    {batch.name} - {program?.name}
                  </option>
                )
              })}
            </select>
          </div>
          
          <div>
            <label className="block text-xs md:text-sm font-medium text-neutral-700 mb-1 md:mb-2">
              Batch 2 (Right Panel)
            </label>
            <select 
              value={selectedBatch2} 
              onChange={(e) => handleBatch2Change(e.target.value)}
              className="w-full px-2 py-1.5 md:px-3 md:py-2 text-xs md:text-sm border border-neutral-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={!selectedCentre}
            >
              <option value="">Select second batch to compare</option>
              {filteredBatches.map((batch) => {
                const program = programs.find(p => p.id === batch.program_id)
                return (
                  <option key={batch.id} value={batch.id}>
                    {batch.name} - {program?.name}
                  </option>
                )
              })}
            </select>
          </div>
        </div>
      </div>

      {/* Split Screen View */}
      <div className="flex-1 flex flex-col lg:flex-row overflow-hidden">
        <div className="flex-1 lg:w-1/2 lg:border-r border-b lg:border-b-0 border-neutral-200 overflow-auto">
          {renderPhaseView(batch1Phases, selectedBatch1)}
        </div>
        <div className="flex-1 lg:w-1/2 overflow-auto">
          {renderPhaseView(batch2Phases, selectedBatch2)}
        </div>
      </div>

      {/* Schedule Detail Modal */}
      {showScheduleModal && selectedSchedule && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4" onClick={() => setShowScheduleModal(false)}>
          <div className="bg-white rounded-lg p-4 sm:p-6 max-w-sm sm:max-w-md w-full mx-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg sm:text-xl font-bold text-neutral-900">Class Details</h3>
              <button onClick={() => setShowScheduleModal(false)} className="text-neutral-400 hover:text-neutral-600 text-xl sm:text-2xl">
                ✕
              </button>
            </div>
            
            <div className="space-y-3 sm:space-y-4">
              <div>
                <label className="text-xs sm:text-sm font-medium text-neutral-600">Subject</label>
                <p className="text-neutral-900 font-semibold text-sm sm:text-base">{selectedSchedule.subject_name}</p>
              </div>
              
              <div>
                <label className="text-xs sm:text-sm font-medium text-neutral-600">Faculty</label>
                <p className="text-neutral-900 font-semibold text-sm sm:text-base">{selectedSchedule.faculty_name}</p>
              </div>
              
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                <div>
                  <label className="text-xs sm:text-sm font-medium text-neutral-600">Day</label>
                  <p className="text-neutral-900 capitalize text-sm sm:text-base">{selectedSchedule.day_of_week}</p>
                </div>
                <div>
                  <label className="text-xs sm:text-sm font-medium text-neutral-600">Time</label>
                  <p className="text-neutral-900 font-mono text-sm sm:text-base">{selectedSchedule.start_time} - {selectedSchedule.end_time}</p>
                </div>
              </div>
              
              {(() => {
                const facultyInfo = faculty.find(f => f.id === selectedSchedule.faculty_id)
                const facultyType = facultyInfo?.faculty_type || 'Unknown'
                const getBadgeInfo = (type: string) => {
                  const lowerType = type.toLowerCase()
                  if (lowerType.includes('permanent')) return { short: 'PERMANENT', color: 'bg-green-600', label: 'Permanent Faculty' }
                  if (lowerType.includes('hourly') || lowerType.includes('contract')) return { short: 'HOURLY/CONTRACT', color: 'bg-orange-500', label: 'Hourly/Contract Faculty' }
                  return { short: 'UNKNOWN', color: 'bg-gray-500', label: 'Unknown Type' }
                }
                const badge = getBadgeInfo(facultyType)
                
                return (
                  <div>
                    <label className="text-xs sm:text-sm font-medium text-neutral-600">Faculty Type</label>
                    <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                      <span className={`text-xs sm:text-sm px-2 sm:px-3 py-1 rounded text-white font-bold ${badge.color} text-center`}>
                        {badge.short}
                      </span>
                      <span className="text-neutral-600 text-xs sm:text-sm">{badge.label}</span>
                    </div>
                  </div>
                )
              })()}
              
              <div className="mt-4 sm:mt-6 flex justify-end">
                <button 
                  onClick={() => setShowScheduleModal(false)}
                  className="w-full sm:w-auto px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors text-sm sm:text-base"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}