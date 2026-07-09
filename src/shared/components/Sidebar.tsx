import { useState, useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import {
  User, Target, LayoutDashboard, CheckSquare, ClipboardList,
  UserCheck, Users, LogOut, Menu, X, Settings,
  CalendarCheck, Wallet, Palmtree, Receipt, CalendarDays, GraduationCap,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useAuth } from '../../features/auth/AuthContext'
import { useCan } from '../../shared/lib/permissions'
import type { Capability } from '../../shared/types'
import { RankBadge } from './RankBadge'
import { Avatar } from './Avatar'

interface NavItem {
  id: string
  label: string
  to: string
  icon: LucideIcon
  /** Anchor id to scroll to after navigating (for items sharing a page) */
  scrollTo?: string
  /** Paths (prefix-matched) where this item should render as active */
  activePaths?: string[]
  /** Capability required to see this item (omit ⇒ visible to everyone). */
  cap?: Capability
  /** Hide this item when the user HAS this capability (avoids duplicates with MGMT items). */
  hideWithCap?: Capability
}

const STAFF_NAV: NavItem[] = [
  { id: 'dashboard',   label: 'Dashboard',  to: '/profile',  icon: LayoutDashboard },
  { id: 'my-profile',  label: 'My Profile', to: '/profile',  icon: User, activePaths: ['/profile'] },
  { id: 'missions',    label: 'Missions',   to: '/missions', icon: Target, activePaths: ['/missions'] },
  { id: 'my-schedule', label: 'My Schedule', to: '/schedule', icon: CalendarDays, activePaths: ['/schedule'], hideWithCap: 'manage_schedule' },
]

const HR_NAV: NavItem[] = [
  { id: 'hr-attendance', label: 'Attendance',     to: '/hr/attendance', icon: CalendarCheck, activePaths: ['/hr/attendance'] },
  { id: 'hr-salary',     label: 'Salary Records', to: '/hr/salary',     icon: Wallet,         activePaths: ['/hr/salary'] },
  { id: 'hr-leave',      label: 'Leave',          to: '/hr/leave',      icon: Palmtree,       activePaths: ['/hr/leave'] },
  { id: 'hr-claims',     label: 'Claims',         to: '/hr/claims',     icon: Receipt,        activePaths: ['/hr/claims'] },
]

const MGMT_NAV: NavItem[] = [
  { id: 'team-dash',  label: 'Team Dashboard',    to: '/dashboard', icon: LayoutDashboard, activePaths: ['/dashboard', '/staff/'], cap: 'view_team' },
  { id: 'schedule',   label: 'Schedule',          to: '/schedule',  icon: CalendarDays,    activePaths: ['/schedule'], cap: 'manage_schedule' },
  { id: 'tasks',      label: 'Tasks',             to: '/tasks',     icon: CheckSquare,     activePaths: ['/tasks'], cap: 'view_team' },
  { id: 'reviews',    label: 'Reviews',           to: '/dashboard', icon: ClipboardList,   scrollTo: 'reviews-section', cap: 'conduct_reviews' },
  { id: 'skills',     label: 'Skill Assessments', to: '/dashboard', icon: GraduationCap,   scrollTo: 'skill-assessments-section', cap: 'conduct_reviews' },
  { id: 'probation',  label: 'Probation Reviews', to: '/dashboard', icon: UserCheck,       scrollTo: 'probation-section', cap: 'conduct_reviews' },
  { id: 'staff-mgmt', label: 'Staff Management',  to: '/dashboard', icon: Users,           scrollTo: 'staff-section', cap: 'view_team' },
]

const SETTINGS_NAV: NavItem[] = [
  { id: 'settings', label: 'Settings', to: '/settings', icon: Settings, activePaths: ['/settings'], cap: 'access_settings' },
]

function isActive(item: NavItem, pathname: string): boolean {
  if (!item.activePaths) return false
  return item.activePaths.some(p => pathname === p || pathname.startsWith(p))
}

function NavLink({ item, pathname, onNavigate }: {
  item: NavItem
  pathname: string
  onNavigate: () => void
}) {
  const active = isActive(item, pathname)
  const Icon = item.icon

  return (
    <Link
      to={item.to}
      onClick={() => {
        if (item.scrollTo) {
          setTimeout(() => {
            document.getElementById(item.scrollTo!)?.scrollIntoView({ behavior: 'smooth' })
          }, 150)
        }
        onNavigate()
      }}
      className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${
        active
          ? 'bg-[#8B6344] text-[#F5F0E8] font-semibold'
          : 'text-[#D4C4B0] hover:bg-[#5A3A22] hover:text-[#F5F0E8]'
      }`}
    >
      <Icon size={16} className="flex-shrink-0" />
      <span className="truncate">{item.label}</span>
    </Link>
  )
}

function SidebarContent({ onNavigate, onClose }: {
  onNavigate: () => void
  onClose?: () => void
}) {
  const { staff, signOut } = useAuth()
  const { pathname } = useLocation()
  const { can } = useCan()
  const staffItems = STAFF_NAV.filter(i => (!i.cap || can(i.cap)) && (!i.hideWithCap || !can(i.hideWithCap)))
  const mgmtItems = MGMT_NAV.filter(i => !i.cap || can(i.cap))
  const settingsItems = SETTINGS_NAV.filter(i => !i.cap || can(i.cap))
  const showMgmtSection = mgmtItems.length > 0 || settingsItems.length > 0

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Logo */}
      <div className="flex items-center justify-between px-4 pt-5 pb-4 flex-shrink-0">
        <Link to="/" className="flex items-center gap-2.5">
          <img src="/craft-logo.jpg" alt="Craft Cafe" className="w-9 h-9 rounded-full object-cover flex-shrink-0" />
          <span className="font-display text-xl font-bold text-[#F5F0E8] tracking-wide">Craft OS</span>
        </Link>
        {onClose && (
          <button onClick={onClose} className="text-[#D4C4B0] hover:text-[#F5F0E8] p-1">
            <X size={20} />
          </button>
        )}
      </div>

      {/* User info */}
      {staff && (
        <div className="px-4 pb-4 flex-shrink-0">
          <div className="flex items-center gap-3 p-3 rounded-xl bg-[#3D2410]">
            <Avatar name={staff.name} avatar={staff.avatar} size="md" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-[#F5F0E8] truncate">{staff.name}</p>
              <div className="mt-1">
                <RankBadge rank={staff.rank} size="sm" />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Nav sections */}
      <nav className="flex-1 px-3 space-y-5 overflow-y-auto pb-2 min-h-0">
        <div>
          <p className="px-3 mb-1.5 text-[10px] font-bold text-[#8B7355] uppercase tracking-widest">
            Staff
          </p>
          <div className="space-y-0.5">
            {staffItems.map(item => (
              <NavLink key={item.id} item={item} pathname={pathname} onNavigate={onNavigate} />
            ))}
          </div>
        </div>

        <div>
          <div className="border-t border-[#5A3A22] mb-3" />
          <p className="px-3 mb-1.5 text-[10px] font-bold text-[#8B7355] uppercase tracking-widest">
            HR
          </p>
          <div className="space-y-0.5">
            {HR_NAV.map(item => (
              <NavLink key={item.id} item={item} pathname={pathname} onNavigate={onNavigate} />
            ))}
          </div>
        </div>

        {showMgmtSection && (
          <div>
            <div className="border-t border-[#5A3A22] mb-3" />
            <p className="px-3 mb-1.5 text-[10px] font-bold text-[#8B7355] uppercase tracking-widest">
              Management
            </p>
            <div className="space-y-0.5">
              {mgmtItems.map(item => (
                <NavLink key={item.id} item={item} pathname={pathname} onNavigate={onNavigate} />
              ))}
              {settingsItems.map(item => (
                <NavLink key={item.id} item={item} pathname={pathname} onNavigate={onNavigate} />
              ))}
            </div>
          </div>
        )}
      </nav>

      {/* Sign out */}
      <div className="px-3 pb-4 pt-3 border-t border-[#5A3A22] flex-shrink-0">
        <button
          onClick={() => { signOut(); onNavigate() }}
          className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm text-[#D4C4B0] hover:bg-[#5A3A22] hover:text-[#F5F0E8] transition-colors"
        >
          <LogOut size={16} className="flex-shrink-0" />
          Sign out
        </button>
      </div>
    </div>
  )
}

export function Sidebar() {
  const [mobileOpen, setMobileOpen] = useState(false)
  const { pathname } = useLocation()

  useEffect(() => { setMobileOpen(false) }, [pathname])

  return (
    <>
      {/* Desktop fixed sidebar */}
      <aside className="hidden sm:block fixed left-0 top-0 h-full w-60 z-30 bg-[#4A2E1A]">
        <SidebarContent onNavigate={() => {}} />
      </aside>

      {/* Mobile sticky top bar */}
      <header className="sm:hidden fixed top-0 left-0 right-0 z-30 h-14 bg-[#4A2E1A] flex items-center justify-between px-4">
        <button onClick={() => setMobileOpen(true)} className="text-[#D4C4B0] hover:text-[#F5F0E8] p-1">
          <Menu size={22} />
        </button>
        <span className="flex items-center gap-2">
          <img src="/craft-logo.jpg" alt="Craft Cafe" className="w-7 h-7 rounded-full object-cover" />
          <span className="font-display text-lg font-bold text-[#F5F0E8] tracking-wide">Craft OS</span>
        </span>
        <div className="w-7" />
      </header>

      {/* Mobile overlay sidebar */}
      {mobileOpen && (
        <>
          <div
            className="sm:hidden fixed inset-0 z-40 bg-black/50"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="sm:hidden fixed left-0 top-0 h-full w-60 z-50 bg-[#4A2E1A] shadow-xl">
            <SidebarContent onNavigate={() => setMobileOpen(false)} onClose={() => setMobileOpen(false)} />
          </aside>
        </>
      )}
    </>
  )
}
