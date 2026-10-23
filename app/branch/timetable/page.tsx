import CentreTimetable from '@/components/central/CentreTimetable'

// The same room-wise day calendar Central sees — view only, limited to the
// branch head's own centre(s).
export default function BranchTimetablePage() {
  return <CentreTimetable scope="branch" />
}
