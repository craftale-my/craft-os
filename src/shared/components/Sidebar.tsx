import { useState, useEffect } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import {
  User, Target, CheckSquare, ClipboardList,
  Users, BookUser, Clock, LogOut, Menu, X, Settings, ChevronDown,
  CalendarCheck, Wallet, Palmtree, Receipt, CalendarDays,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useAuth } from '../../features/auth/AuthContext'
import { useCan } from '../../shared/lib/permissions'
import { visibleNav, activeEntry, isGroup } from '../lib/nav'
import type { NavLeaf, NavGroup } from '../lib/nav'
import { RankBadge } from './RankBadge'
import { Avatar } from './Avatar'

// 叶子项与大类共用一张表:大类标题也要出图标,否则它的文字会顶到
// 图标的位置,和下面子项的标签对不齐。
const ICONS: Record<string, LucideIcon> = {
  profile: User,
  team: Users,
  'time-pay': Clock,
  directory: BookUser,
  'team-reviews': ClipboardList,
  'team-missions': Target,
  'team-tasks': CheckSquare,
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

export function SidebarContent({ onNavigate, onClose }: {
  onNavigate: () => void
  onClose?: () => void
}) {
  const { staff, signOut } = useAuth()
  const { pathname } = useLocation()
  const { can } = useCan()
  const navigate = useNavigate()

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
    if (group.children[0]) { navigate(group.children[0].to); onNavigate() }
  }

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
          return (
            <div key={entry.id}>
              <button
                onClick={() => toggleGroup(entry)}
                className="flex items-center justify-between w-full px-3 py-2.5 rounded-lg text-sm
                           text-[#D4C4B0] hover:bg-[#5A3A22] hover:text-[#F5F0E8] transition-colors"
              >
                <span className="flex items-center gap-3 min-w-0">
                  {GroupIcon && <GroupIcon size={16} className="flex-shrink-0" />}
                  <span className="font-semibold tracking-wide truncate">{entry.label}</span>
                </span>
                <ChevronDown size={14} className={`flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
              </button>
              {open && (
                <div className="mt-0.5 ml-3 pl-2 border-l border-[#5A3A22] space-y-0.5">
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
