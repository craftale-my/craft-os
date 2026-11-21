import { useEffect, useState } from 'react'
import { countNewFeedback } from './api'

/**
 * Owner 侧栏徽标。不订阅 realtime:SidebarContent 在手机抽屉打开时会挂第二份
 * (见 Sidebar.tsx 铃铛旁的注释),订阅会开两条频道。换页时重查就够了。
 */
export function useNewFeedbackCount(enabled: boolean, refreshKey: string): number {
  const [count, setCount] = useState(0)
  useEffect(() => {
    if (!enabled) { setCount(0); return }
    let live = true
    countNewFeedback().then(n => { if (live) setCount(n) })
    return () => { live = false }
  }, [enabled, refreshKey])
  return count
}
