import { Suspense } from 'react'
import LoginForm from './LoginForm'

export default function LoginPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-neutral-950">
        <p className="text-neutral-400 text-sm">Loading…</p>
      </div>
    }>
      <LoginForm />
    </Suspense>
  )
}
