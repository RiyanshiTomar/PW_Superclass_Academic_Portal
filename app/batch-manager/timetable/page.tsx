import CentreTimetable from '@/components/central/CentreTimetable'

// The same room-wise day calendar Central sees — view only, limited to the
// centre(s) of the batch manager's batches.
export default function BatchManagerTimetablePage() {
  return <CentreTimetable scope="batch-manager" />
}
