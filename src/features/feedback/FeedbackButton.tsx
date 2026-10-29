import { useCallback, useEffect, useRef, useState } from 'react'
import { MessageSquare } from 'lucide-react'
import { useAuth } from '../auth/AuthContext'
import { FeedbackSheet } from './FeedbackSheet'
import { notifyFeedbackSent, useFeedbackRequests } from './feedbackBus'
import type { FeedbackPrefill } from './feedbackBus'

/** 每页右下角的悬浮按钮,同时是表单的唯一挂载点。在 <Sidebar> 里只挂一次。 */
export function FeedbackButton() {
  const { staff } = useAuth()
  const [session, setSession] = useState<{ n: number; prefill: FeedbackPrefill } | null>(null)
  const [thanks, setThanks] = useState(false)
  const counter = useRef(0)

  // 每次打开换一个 key,表单状态从头开始
  const open = useCallback((prefill: FeedbackPrefill = {}) => {
    counter.current += 1
    setSession({ n: counter.current, prefill })
  }, [])
  useFeedbackRequests(open)

  useEffect(() => {
    if (!thanks) return
    const t = setTimeout(() => setThanks(false), 3000)
    return () => clearTimeout(t)
  }, [thanks])

  if (!staff) return null

  return (
    <>
      <button
        onClick={() => open()}
        aria-label="Send feedback"
        className="fixed right-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-30 flex items-center gap-2
                   rounded-full bg-[#4A2E1A] text-[#F5F0E8] px-4 py-2.5 text-sm font-semibold shadow-lg
                   hover:bg-[#5A3A22] transition-colors"
      >
        <MessageSquare size={16} />
        Feedback
      </button>

      {session && (
        <FeedbackSheet
          key={session.n}
          prefill={session.prefill}
          onClose={() => setSession(null)}
          onSent={() => { setSession(null); setThanks(true); notifyFeedbackSent() }}
        />
      )}

      {thanks && (
        <div role="status" className="fixed bottom-20 right-4 z-50 bg-[#3D2410] text-white text-sm font-medium px-4 py-2.5 rounded-xl shadow-xl">
          Thanks — your feedback was sent.
        </div>
      )}
    </>
  )
}
