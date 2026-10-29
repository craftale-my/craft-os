import { useEffect, useRef } from 'react'
import type { FeedbackCategory } from './types'

export interface FeedbackPrefill {
  category?: FeedbackCategory
  errorMessage?: string
}

type Listener = (prefill: FeedbackPrefill) => void
const listeners = new Set<Listener>()

/**
 * 从任何地方打开反馈表单(报错页、侧栏以外的按钮)。
 * 表单只由 FeedbackButton 挂一次;它不在页面的 ErrorBoundary 里面,
 * 所以页面崩了也能打开。
 */
export function openFeedback(prefill: FeedbackPrefill = {}) {
  listeners.forEach(l => l(prefill))
}

export function useFeedbackRequests(onOpen: Listener) {
  const ref = useRef(onOpen)
  useEffect(() => { ref.current = onOpen })
  useEffect(() => {
    const l: Listener = p => ref.current(p)
    listeners.add(l)
    return () => { listeners.delete(l) }
  }, [])
}
