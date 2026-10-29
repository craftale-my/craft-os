import { useState, useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import {
  User, Target, CheckSquare, ClipboardList, FolderKanban,
  Users, BookUser, Clock, LogOut, Menu, X, Settings, ChevronDown,
  CalendarCheck, Wallet, Palmtree, Receipt, CalendarDays, Network, Headset, ExternalLink,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useAuth } from '../../features/auth/AuthContext'
import { useCan } from '../../shared/lib/permissions'
import { visibleNav, activeEntry, isGroup } from '../lib/nav'
import type { NavLeaf, NavGroup } from '../lib/nav'
import { AddToHomeScreenLogo } from './AddToHomeScreen'
import { RankBadge } from './RankBadge'
import { Avatar } from './Avatar'
import { Wordmark } from './ui'
import { NotificationBell } from '../../features/notifications/NotificationBell'
import { openCustomerService } from '../lib/customerService'

// 叶子项与大类共用一张表:大类标题也要出图标,否则它的文字会顶到
// 图标的位置,和下面子项的标签对不齐。
const ICONS: Record<string, LucideIcon> = {
  profile: User,
  'org-chart': Network,
  team: Users,
  'time-pay': Clock,
  directory: BookUser,
  'team-reviews': ClipboardList,
  'team-missions': Target,
  'team-tasks': CheckSquare,
  'team-projects': FolderKanban,
  schedule: CalendarDays,
  attendance: CalendarCheck,
  leave: Palmtree,
  claims: Receipt,
  salary: Wallet,
  settings: Settings,
}

function NavLink({ leaf, active, onNavigate }: {
  leaf: NavLeaf
  active: boolean
  onNavigate: () => void
}) {
  const Icon = ICONS[leaf.id]
  return (
    <Link
      to={leaf.to}
      onClick={onNavigate}
      className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${
        active
          ? 'bg-[#8B6344] text-[#F5F0E8] font-semibold'
          : 'text-[#D4C4B0] hover:bg-[#5A3A22] hover:text-[#F5F0E8]'
      }`}
    >
      {Icon && <Icon size={16} className="flex-shrink-0" />}
      <span className="truncate">{leaf.label}</span>
    </Link>
  )
}

// Not a route in this app: opens Craft Marketing (the inbox) in a new tab,
// already signed in. Lives outside NAV because it's gated by staff.cs_role,
// not by a system-role capability.
function CustomerServiceLink({ onNavigate }: { onNavigate: () => void }) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function handleClick() {
    if (busy) return
    setMessage(null)
    setBusy(true)
    const problem = await openCustomerService()
    setBusy(false)
    if (problem) { setMessage(problem); return }
    onNavigate()
  }

  return (
    <div>
      <button
        onClick={handleClick}
        disabled={busy}
        className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm text-[#D4C4B0] hover:bg-[#5A3A22] hover:text-[#F5F0E8] transition-colors disabled:opacity-60"
      >
        <Headset size={16} className="flex-shrink-0" />
        <span className="truncate">Customer Service</span>
        <ExternalLink size={12} className="ml-auto flex-shrink-0 opacity-60" />
      </button>
      {message && (
        <p role="alert" className="px-3 pt-1 text-[11px] leading-snug text-[#F0C9A0]">{message}</p>
      )}
    </div>
  )
}

export function SidebarContent({ onNavigate, onClose }: {
  onNavigate: () => void
  onClose?: () => void
}) {
  const { staff, signOut } = useAuth()
  const { pathname } = useLocation()
  const { can } = useCan()

  const nav = visibleNav(can)
  const active = activeEntry(nav, pathname)
  const [openGroup, setOpenGroup] = useState<string | null>(active?.groupId ?? null)

  // 路由变化时,让当前所在的大类保持展开
  useEffect(() => {
    if (active?.groupId) setOpenGroup(active.groupId)
  }, [active?.groupId])

  function toggleGroup(group: NavGroup) {
    if (openGroup === group.id) { setOpenGroup(null); return }
    setOpenGroup(group.id)
  }

  return (
    <div className="flex flex-col h-full min-h-0 font-brand">
      {/* Logo */}
      <div className="flex items-center justify-between px-4 pt-5 pb-4 flex-shrink-0">
        <Link to="/" className="flex items-center gap-2">
          <img src="/craft-logo.jpg" alt="" className="w-8 h-8 rounded-full object-cover flex-shrink-0" />
          <Wordmark />
        </Link>
        {/* No bell here — see the comment on <Sidebar> for why it lives
            there instead, mounted exactly once. */}
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
              <p className="type-semicondensed text-sm font-bold text-[#F5F0E8] truncate">{staff.name}</p>
              <div className="mt-1">
                <RankBadge rank={staff.rank} size="sm" />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Nav */}
      <nav className="flex-1 px-3 space-y-1 overflow-y-auto pb-2 min-h-0">
        {nav.map(entry => {
          if (!isGroup(entry)) {
            return (
              <NavLink
                key={entry.id}
                leaf={entry}
                active={active?.leafId === entry.id}
                onNavigate={onNavigate}
              />
            )
          }
          const open = openGroup === entry.id
          const GroupIcon = ICONS[entry.id]
          const childrenId = `nav-group-${entry.id}`
          return (
            <div key={entry.id}>
              <button
                onClick={() => toggleGroup(entry)}
                aria-expanded={open}
                aria-controls={childrenId}
                className="flex items-center justify-between w-full px-3 py-2.5 rounded-lg text-sm
                           text-[#D4C4B0] hover:bg-[#5A3A22] hover:text-[#F5F0E8] transition-colors"
              >
                <span className="flex items-center gap-3 min-w-0">
                  {GroupIcon && <GroupIcon size={16} className="flex-shrink-0" />}
                  <span className="type-semicondensed font-bold tracking-wide truncate">{entry.label}</span>
                </span>
                <ChevronDown size={14} className={`flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
              </button>
              {open && (
                <div id={childrenId} className="mt-0.5 ml-3 pl-2 border-l border-[#5A3A22] space-y-0.5">
                  {entry.children.map(leaf => (
                    <NavLink
                      key={leaf.id}
                      leaf={leaf}
                      active={active?.leafId === leaf.id}
                      onNavigate={onNavigate}
                    />
                  ))}
                </div>
              )}
            </div>
          )
        })}
        {staff?.cs_role && <CustomerServiceLink onNavigate={onNavigate} />}
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
      {/* The single notification bell for the whole sidebar.
          I6: NotificationBell used to live inside SidebarContent, which is
          NOT a stable one-instance-per-viewport thing — the desktop <aside>
          below stays mounted at all times (only hidden by CSS, "hidden
          sm:block"), so opening the mobile drawer mounts a SECOND
          SidebarContent alongside it. A bell inside SidebarContent would
          then run two useNotifications() hooks, fire two initial fetches,
          and open two `notifications:<staffId>` realtime channel
          subscriptions on the same topic at once.
          Mounting it once here — outside both SidebarContent instances —
          fixes that, and fixed positioning (not flow inside the header or
          aside) lets this one instance sit correctly in either chrome:
          docked in the mobile top bar, where it's visible at rest (this is
          a phone-first app — clock-in is camera + GPS — so a badge whose
          whole purpose is passive awareness has to be visible without
          opening the drawer), and in the desktop sidebar's logo row.
          z-[60] keeps it above the mobile drawer/overlay (z-50/z-40) so it
          stays visible and clickable regardless of drawer state too. */}
      <div className="fixed z-[60] top-0 h-14 right-4 flex items-center sm:h-auto sm:top-6 sm:right-auto sm:left-[12.25rem]">
        <NotificationBell />
      </div>

      {/* Desktop fixed sidebar */}
      <aside className="hidden sm:block fixed left-0 top-0 h-full w-60 z-30 bg-[#4A2E1A]">
        <SidebarContent onNavigate={() => {}} />
      </aside>

      {/* Mobile sticky top bar */}
      <header className="sm:hidden fixed top-0 left-0 right-0 z-30 h-14 bg-[#4A2E1A] flex items-center justify-between px-4">
        <button onClick={() => setMobileOpen(true)} className="text-[#D4C4B0] hover:text-[#F5F0E8] p-1">
          <Menu size={22} />
        </button>
        <AddToHomeScreenLogo />
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
