import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Bell } from 'lucide-react'
import { useAuth } from '../auth/AuthContext'
import { useNotifications } from './useNotifications'

export function NotificationBell() {
  const { staff } = useAuth()
  const { items, unread, markRead } = useNotifications(staff?.id)
  const [open, setOpen] = useState(false)
  if (!staff) return null

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="relative text-[#D4C4B0] hover:text-[#F5F0E8] p-1"
        aria-label="Notifications"
      >
        <Bell size={20} />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-[#C4813A] text-[10px] font-bold text-white flex items-center justify-center">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-72 max-h-80 overflow-y-auto bg-white rounded-xl shadow-lg border border-[#E8DDD0] z-50">
          {items.length === 0 && <p className="p-4 text-sm text-brown-faint">Nothing new.</p>}
          {items.map(n => (
            <Link
              key={n.id}
              to={n.link ?? '#'}
              onClick={() => { markRead(n.id); setOpen(false) }}
              className={`block px-4 py-3 border-b border-[#F0E8DC] last:border-0 ${n.read_at ? 'opacity-60' : ''}`}
            >
              <p className="text-sm font-semibold text-brown-dark">{n.title}</p>
              {n.body && <p className="text-xs text-brown-faint mt-0.5">{n.body}</p>}
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
