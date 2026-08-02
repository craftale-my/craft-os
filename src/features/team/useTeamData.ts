import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../shared/lib/supabase'
import type { Staff } from '../../shared/types'

/**
 * Directory 与 Reviews 共用的全员名册。两页都要,分开取会重复请求。
 *
 * 查询与拆分前 Dashboard.loadAll() 里的那一条完全一致:不带 status/branch 过滤,
 * 按 name 排序。分支范围与在职过滤都是各页自己在内存里做的(见 Directory 的
 * inBranchScope / activeStaff),这里不能提前收窄,否则 Reviews 的
 * handleStartReviews 与试用期名单会少人。
 */
export function useTeamData() {
  const [staff, setStaff] = useState<Staff[]>([])
  const [loading, setLoading] = useState(true)

  // `loading` 只表示首屏那一次还没回来 —— 与拆分前 Dashboard 的 loading 语义
  // 一致。刷新时不能再翻回 true:调用方是拿它整页兜底的,一翻就会把正在显示的
  // 弹窗(例如审批注册后那张临时密码卡)连同页面一起卸载掉。
  const reload = useCallback(() => {
    supabase.from('staff').select('*').order('name').then(({ data }) => {
      if (data) setStaff(data as Staff[])
      setLoading(false)
    })
  }, [])

  useEffect(() => { reload() }, [reload])

  return { staff, loading, reload }
}
