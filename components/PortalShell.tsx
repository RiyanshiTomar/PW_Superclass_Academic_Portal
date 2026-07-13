'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import LogoutButton from './LogoutButton'
import Logo from './Logo'

export type NavItem = { label: string; href: string; icon?: string }

type PortalShellProps = {
  children: React.ReactNode
  role: string
  fullName: string
  homeHref: string
  navItems: NavItem[]
}

function roleLabel(role: string) {
  return role.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return 'U'
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase()
}

export default function PortalShell({
  children,
  role,
  fullName,
  homeHref,
  navItems,
}: PortalShellProps) {
  const pathname = usePathname()

  return (
    <div className="min-h-screen bg-mesh flex">
      <aside className="hidden lg:flex w-64 flex-col bg-neutral-950 text-neutral-300 relative overflow-hidden">
        {/* ambient violet glow inside the dark rail */}
        <div className="pointer-events-none absolute -top-20 -left-10 h-56 w-56 rounded-full bg-violet-500/20 blur-3xl" />
        <div className="pointer-events-none absolute bottom-10 -right-16 h-56 w-56 rounded-full bg-violet-600/10 blur-3xl" />

        <div className="relative px-5 py-6 border-b border-white/10">
          <Link href={homeHref} className="block transition-transform hover:scale-[1.02]">
            <Logo variant="full" onDark size="lg" />
            <span className="block text-[10px] font-semibold text-violet-400/70 uppercase tracking-[0.2em] mt-3 pl-0.5">
              {roleLabel(role)} Portal
            </span>
          </Link>
        </div>
        <nav className="relative flex-1 px-3 py-5 space-y-1.5">
          {navItems.map((item, i) => {
            const active = pathname === item.href || (item.href !== homeHref && pathname.startsWith(item.href + '/'))
            return (
              <Link
                key={item.href}
                href={item.href}
                style={{ animationDelay: `${i * 70}ms` }}
                className={`animate-fade-up group relative flex items-center gap-3 px-3.5 py-3 rounded-xl text-sm font-semibold transition-all duration-300 ${
                  active
                    ? 'bg-gradient-to-r from-violet-600 to-indigo-600 text-white shadow-lg shadow-violet-500/30'
                    : 'text-neutral-400 hover:bg-white/5 hover:text-white hover:translate-x-1'
                }`}
              >
                {item.icon && <span className="text-lg leading-none transition-transform group-hover:scale-110">{item.icon}</span>}
                {item.label}
                {active && <span className="ml-auto h-2 w-2 rounded-full bg-white animate-glow" />}
              </Link>
            )
          })}
        </nav>
        <div className="relative px-4 py-4 border-t border-white/10">
          <div className="flex items-center gap-3 mb-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-violet-600 to-indigo-600 text-white text-xs font-bold shadow-md shadow-violet-500/40">{initials(fullName)}</span>
            <p className="text-sm font-semibold text-white truncate">{fullName || 'User'}</p>
          </div>
          <Link href="/account" className="block text-center text-xs font-medium text-neutral-400 hover:text-white mb-2 transition-colors">Change password</Link>
          <LogoutButton className="w-full !text-neutral-300 !border-white/15 hover:!bg-white/10 hover:!text-white hover:!border-white/30" />
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="lg:hidden bg-neutral-950 px-4 py-3 flex items-center justify-between sticky top-0 z-30">
          <Logo variant="full" onDark size="sm" />
          <LogoutButton className="!text-neutral-300 !border-white/15 hover:!bg-white/10 hover:!text-white" />
        </header>
        <main className="flex-1 p-4 sm:p-6 lg:p-10">
          {/* No transform-based animation here: a lingering transform makes it the
              containing block for position:fixed modals, pushing them off-screen on
              long/scrolled pages. Keep page content transform-free. */}
          <div>{children}</div>
        </main>
      </div>
    </div>
  )
}

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string
  description?: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-8">
      <div className="flex items-start gap-3.5">
        <span className="mt-1 h-9 w-1.5 shrink-0 rounded-full bg-gradient-to-b from-violet-400 to-violet-600" />
        <div>
          <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-neutral-950">{title}</h1>
          {description && <p className="text-sm text-neutral-500 mt-1.5 max-w-2xl leading-relaxed">{description}</p>}
        </div>
      </div>
      {action}
    </div>
  )
}

export function Alert({
  type,
  children,
}: {
  type: 'success' | 'error' | 'info'
  children: React.ReactNode
}) {
  const styles = {
    success: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    error: 'bg-red-50 text-red-800 border-red-200',
    info: 'bg-violet-50 text-violet-800 border-violet-200',
  }
  const icon = { success: '✓', error: '!', info: 'i' }
  return (
    <div className={`mb-6 p-4 rounded-xl text-sm font-medium border flex items-start gap-3 ${styles[type]}`}>
      <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-white/60 text-xs font-bold">{icon[type]}</span>
      <span>{children}</span>
    </div>
  )
}

export function Card({
  children,
  className = '',
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={`bg-white/90 border border-neutral-200/70 rounded-2xl shadow-sm hover:shadow-md transition-shadow duration-300 ${className}`}
    >
      {children}
    </div>
  )
}

export function BtnPrimary({
  children,
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`btn-shine h-10 px-5 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-700 hover:to-indigo-700 disabled:from-neutral-300 disabled:to-neutral-300 text-white rounded-xl text-sm font-semibold shadow-md shadow-violet-500/25 disabled:shadow-none transition-all active:scale-[0.97] ${className}`}
      {...props}
    >
      {children}
    </button>
  )
}

export function BtnSecondary({
  children,
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`h-10 px-5 bg-white border border-neutral-200 hover:bg-neutral-50 hover:border-neutral-300 text-neutral-700 rounded-xl text-sm font-semibold transition-colors ${className}`}
      {...props}
    >
      {children}
    </button>
  )
}

export function DashboardGrid({
  items,
}: {
  items: { title: string; desc: string; href: string }[]
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {items.map((card, i) => (
        <Link href={card.href} key={card.title} style={{ animationDelay: `${i * 70}ms` }} className="animate-fade-up">
          <div className="hover-lift group bg-white/90 border border-neutral-200/70 rounded-2xl p-6 hover:border-violet-400 hover:shadow-xl hover:shadow-violet-500/15 h-full">
            <h3 className="font-semibold text-neutral-950 mb-1 group-hover:text-violet-600 transition-colors">
              {card.title}
            </h3>
            <p className="text-sm text-neutral-500">{card.desc}</p>
          </div>
        </Link>
      ))}
    </div>
  )
}
