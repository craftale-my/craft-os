import { useState, useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import {
  User, Target, CheckSquare, ClipboardList, FolderKanban,
  Users, BookUser, Clock, LogOut, Menu, X, Settings, ChevronsUpDown, LayoutGrid, ListChecks,
  CalendarCheck, Wallet, Palmtree, Receipt, CalendarDays, Network,
  ShoppingBasket, Truck, Package, ShoppingCart, PackageCheck, Boxes, Trash2, ArrowLeftRight,
  ChefHat, Headset, ExternalLink, MessageSquare,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useAuth } from '../../features/auth/AuthContext'
import { useCan } from '../../shared/lib/permissions'
import { visibleNav, activeEntry, navShell } from '../lib/nav'
import type { NavLeaf, NavGroup } from '../lib/nav'
import { AddToHomeScreenLogo } from './AddToHomeScreen'
import { RankBadge } from './RankBadge'
import { Avatar } from './Avatar'
import { Wordmark } from './ui'
import { NotificationBell } from '../../features/notifications/NotificationBell'
import { FeedbackButton } from '../../features/feedback/FeedbackButton'
import { useNewFeedbackCount } from '../../features/feedback/useNewFeedbackCount'
import { openCustomerService } from '../lib/customerService'

// 叶子项与模块共用一张表:切换器里的模块格子也要出图标。
const ICONS: Record<string, LucideIcon> = {
  profile: User,
  'org-chart': Network,
  people: Users,
  work: ListChecks,
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
  inventory: ShoppingBasket,
  'proc-suppliers': Truck,
  'proc-items': Package,
  'proc-orders': ShoppingCart,
  'proc-receiving': PackageCheck,
  'proc-transfers': ArrowLeftRight,
  'proc-wastage': Trash2,
  'proc-recipes': ChefHat,
  'proc-inventory': Boxes,
  settings: Settings,
  feedback: MessageSquare,
}

function NavLink({ leaf, active, onNavigate, badge = 0 }: {
  leaf: NavLeaf
  active: boolean
  onNavigate: () => void
  badge?: number
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
      {badge > 0 && (
        <span
          aria-label={`${badge} new`}
          className="ml-auto min-w-[18px] h-[18px] px-1 rounded-full bg-[#C4813A] text-[10px] font-bold text-white flex items-center justify-center"
        >
          {badge > 9 ? '9+' : badge}
        </span>
      )}
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
    let problem: string | null
    try {
      problem = await openCustomerService()
    } finally {
      setBusy(false)
    }
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

/** 上次所在的模块。纯粹是每台设备自己的便利,读写失败都无所谓。 */
const MODULE_KEY = 'craftos.nav.module'
function readStoredModule(): string | null {
  try { return localStorage.getItem(MODULE_KEY) } catch { return null }
}
function storeModule(id: string) {
  try { localStorage.setItem(MODULE_KEY, id) } catch { /* private mode */ }
}

/**
 * 模块切换面板。桌面是贴着侧栏的浮层,手机是底部抽屉 —— 手机侧栏只有
 * 240px 宽,两栏格子塞不进去。
 */
function ModuleSwitcher({ modules, currentId, onPick, onClose }: {
  modules: NavGroup[]
  currentId: string | null
  onPick: (id: string) => void
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <>
      <div className="fixed inset-0 z-[70] bg-black/40 sm:bg-transparent" onClick={onClose} />
      <div
        role="dialog"
        aria-label="Switch module"
        className="fixed z-[71] inset-x-0 bottom-0 rounded-t-2xl p-4 pb-6 bg-white shadow-2xl font-brand
                   sm:inset-x-auto sm:bottom-auto sm:left-3 sm:top-[7.25rem] sm:w-[34rem] sm:rounded-2xl sm:pb-4"
      >
        <p className="px-2 pb-2 text-[11px] font-bold uppercase tracking-widest text-[#6B5A4A]">Switch to</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
          {modules.map(m => {
            const Icon = ICONS[m.id]
            const current = m.id === currentId
            return (
              <button
                key={m.id}
                onClick={() => onPick(m.id)}
                aria-current={current ? 'true' : undefined}
                className={`flex items-center gap-3 px-3 py-2.5 min-h-[60px] rounded-xl text-left transition-colors ${
                  current ? 'bg-[#F3E9DA]' : 'hover:bg-[#F8F2E8]'
                }`}
              >
                <span className={`flex items-center justify-center w-10 h-10 rounded-lg flex-shrink-0 ${
                  current ? 'bg-[#4A2E1A] text-[#F5F0E8]' : 'bg-[#F0E6D6] text-[#4A2E1A]'
                }`}>
                  {Icon && <Icon size={20} />}
                </span>
                <span className="min-w-0">
                  <span className="block type-semicondensed text-[15px] font-bold text-[#2B1A0E]">{m.label}</span>
                  {m.desc && <span className="block text-xs text-[#6B5A4A]">{m.desc}</span>}
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </>
  )
}

export function SidebarContent({ onNavigate, onClose }: {
  onNavigate: () => void
  onClose?: () => void
}) {
  const { staff, signOut } = useAuth()
  const { pathname, search } = useLocation()
  const { can } = useCan()
  const newFeedback = useNewFeedbackCount(staff?.system_role === 'owner', pathname + search)

  const nav = visibleNav(can)
  const { modules, pinned, flat } = navShell(nav)
  const active = activeEntry(nav, pathname)

  // 侧栏当前列的是哪个模块。优先跟着路由走;路由不属于任何模块时
  // (Profile / Settings / Feedback / 首页)回到上次所在的那个。
  const [picked, setPicked] = useState<string | null>(() => active?.groupId ?? readStoredModule())
  const [switcherOpen, setSwitcherOpen] = useState(false)

  useEffect(() => {
    if (!active?.groupId) return
    setPicked(active.groupId)
    storeModule(active.groupId)
  }, [active?.groupId])

  const current = modules.find(m => m.id === picked) ?? modules[0] ?? null
  const pages: NavLeaf[] = flat ? modules.flatMap(m => m.children) : current?.children ?? []
  const CurrentIcon = current ? ICONS[current.id] : undefined

  // 选模块只换侧栏列出的页面,不跳转:手机上一跳转抽屉就关了,
  // 用户还得再打开一次才能选到真正要去的那一页。
  function pickModule(id: string) {
    setPicked(id)
    storeModule(id)
    setSwitcherOpen(false)
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

      {/* Module switcher */}
      {!flat && current && (
        <div className="px-4 pb-3 flex-shrink-0">
          <button
            onClick={() => setSwitcherOpen(o => !o)}
            aria-haspopup="dialog"
            aria-expanded={switcherOpen}
            aria-label={`Switch module, current: ${current.label}`}
            className="flex items-center gap-3 w-full px-3 py-2.5 rounded-xl border border-[#6B4A30] bg-[#3D2410]
                       text-left text-[#F5F0E8] hover:bg-[#5A3A22] transition-colors"
          >
            <LayoutGrid size={16} className="flex-shrink-0 text-[#D4C4B0]" />
            <span className="flex-1 min-w-0">
              <span className="block text-[10px] uppercase tracking-widest text-[#D4C4B0]">Module</span>
              <span className="flex items-center gap-1.5 type-semicondensed text-sm font-bold truncate">
                {CurrentIcon && <CurrentIcon size={14} className="flex-shrink-0" />}
                {current.label}
              </span>
            </span>
            <ChevronsUpDown size={14} className="flex-shrink-0 text-[#D4C4B0]" />
          </button>
          {switcherOpen && (
            <ModuleSwitcher
              modules={modules}
              currentId={current.id}
              onPick={pickModule}
              onClose={() => setSwitcherOpen(false)}
            />
          )}
        </div>
      )}

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

      {/* Pages of the current module (or every page, when flat) */}
      <nav
        aria-label={flat || !current ? 'Pages' : `${current.label} pages`}
        className="flex-1 px-3 space-y-1 overflow-y-auto pb-2 min-h-0"
      >
        {pages.map(leaf => (
          <NavLink
            key={leaf.id}
            leaf={leaf}
            active={active?.leafId === leaf.id}
            onNavigate={onNavigate}
          />
        ))}
      </nav>

      {/* Pinned: the same in every module */}
      <div className="px-3 pb-4 pt-3 border-t border-[#5A3A22] flex-shrink-0 space-y-1">
        {pinned.map(leaf => (
          <NavLink
            key={leaf.id}
            leaf={leaf}
            active={active?.leafId === leaf.id}
            onNavigate={onNavigate}
            badge={leaf.id === 'feedback' ? newFeedback : 0}
          />
        ))}
        {staff?.cs_role && <CustomerServiceLink onNavigate={onNavigate} />}
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

      {/* 和铃铛同理只挂一次:悬浮按钮 + 反馈表单的唯一挂载点 */}
      <FeedbackButton />

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
