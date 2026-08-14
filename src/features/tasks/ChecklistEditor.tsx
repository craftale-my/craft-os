import { useState, useEffect, useCallback } from 'react'
import { CheckSquare, Square, X } from 'lucide-react'
import { Avatar } from '../../shared/components/Avatar'
import { POSITION_STEP, projectProgress } from '../../shared/lib/tasks'
import type { Staff } from '../../shared/types'
import {
  fetchChecklist, addChecklistItem, setChecklistDone,
  setChecklistAssignee, deleteChecklistItem,
} from './api'
import type { ChecklistItem, StaffLite } from './types'

/**
 * 一个任务底下的子项清单。
 *
 * 自行载入自己的 items,不挂进看板查询 —— 板上一次几十张卡,每张都拖一串
 * 子项进来只为了画一行 `3/7`,那笔流量是白花的;看板要的聚合数字
 * (_checklist_total / _checklist_done)由 TASK_SELECT 的 count 形态取得。
 *
 * 打勾走乐观更新(勾一下要立刻有反应),失败滚回原状并把原因讲出来 ——
 * 弹窗是 fixed inset-0 z-50,页面横幅整个被盖住,错误只能显示在这里面。
 * 新增 / 删除刻意不做乐观更新:两者都会改变看板上的 `3/7`,得等
 * onChanged() 重拉板才算数,先假装成功反而会跟板上的数字对不起来。
 */
export function ChecklistEditor({ taskId, allStaff, onChanged }: {
  taskId: string
  allStaff: Staff[]
  /** 子项的完成数变了 —— 请页面层重拉板,卡片上的 `3/7` 与完成闸门都靠它。 */
  onChanged: () => void
}) {
  const [items,   setItems]   = useState<ChecklistItem[]>([])
  const [draft,   setDraft]   = useState('')
  const [loading, setLoading] = useState(true)
  const [saving,  setSaving]  = useState(false)
  const [error,   setError]   = useState('')

  const load = useCallback(async () => {
    try {
      setItems(await fetchChecklist(taskId))
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the checklist.')
    } finally {
      setLoading(false)
    }
  }, [taskId])

  useEffect(() => { load() }, [load])

  const total = items.length
  const done  = items.filter(i => i.done).length
  const pct   = projectProgress(done, total)

  async function toggle(item: ChecklistItem) {
    setItems(prev => prev.map(i => (i.id === item.id ? { ...i, done: !i.done } : i)))
    const res = await setChecklistDone(item.id, !item.done)
    if (!res.ok) {
      setItems(prev => prev.map(i => (i.id === item.id ? { ...i, done: item.done } : i)))
      setError(`Could not update the item — ${res.reason}`)
      return
    }
    setError('')
    onChanged()
  }

  /** 认领 / 放回 "Anyone"。不呼叫 onChanged():这一步不动 done/total,板上没有一个数字会因此改变。 */
  async function assign(item: ChecklistItem, staffId: string) {
    const person = allStaff.find(s => s.id === staffId)
    const next: StaffLite | null = person
      ? { id: person.id, name: person.name, avatar: person.avatar }
      : null
    setItems(prev => prev.map(i => (
      i.id === item.id ? { ...i, assigned_to: staffId || null, assignee: next } : i
    )))
    const res = await setChecklistAssignee(item.id, staffId || null)
    if (!res.ok) {
      setItems(prev => prev.map(i => (
        i.id === item.id
          ? { ...i, assigned_to: item.assigned_to, assignee: item.assignee ?? null }
          : i
      )))
      setError(`Could not change the owner — ${res.reason}`)
      return
    }
    setError('')
  }

  async function add() {
    const title = draft.trim()
    if (!title || saving) return
    // 接在最后一条之后。取现有最大值而不是 items.length,才不会在删过几条之后
    // 撞上还留着的 position。
    const nextPosition = items.length
      ? Math.max(...items.map(i => i.position)) + POSITION_STEP
      : POSITION_STEP
    setSaving(true)
    const res = await addChecklistItem(taskId, title, nextPosition)
    setSaving(false)
    if (!res.ok) { setError(`Could not add the item — ${res.reason}`); return }
    setError('')
    setDraft('')
    await load()
    onChanged()
  }

  async function remove(item: ChecklistItem) {
    const res = await deleteChecklistItem(item.id)
    if (!res.ok) { setError(`Could not remove the item — ${res.reason}`); return }
    setError('')
    await load()
    onChanged()
  }

  return (
    <div data-testid="checklist-editor">
      <div className="flex items-center justify-between mb-1.5">
        <p className="text-xs font-semibold text-[#8B7355]">Checklist</p>
        {total > 0 && (
          <span className="text-xs font-semibold text-[#8B7355]" data-testid="checklist-count">
            {done}/{total}
          </span>
        )}
      </div>

      {total > 0 && (
        <div className="h-1 rounded-full bg-[#EDE5D8] overflow-hidden mb-2.5">
          <div
            className="h-full rounded-full bg-[#C4813A] transition-all duration-200"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}

      {error && (
        <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2 mb-2">{error}</p>
      )}

      {loading ? (
        <p className="text-xs text-[#A09080]">Loading checklist...</p>
      ) : (
        <ul className="space-y-1 mb-2">
          {items.map(item => (
            <li
              key={item.id}
              data-testid={`checklist-item-${item.id}`}
              className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[#F5EDE0] transition-colors"
            >
              <button
                type="button"
                onClick={() => toggle(item)}
                aria-label={`Toggle "${item.title}"`}
                className={item.done ? 'text-[#C4813A]' : 'text-[#A09080] hover:text-[#8B7355]'}
              >
                {item.done ? <CheckSquare size={15} /> : <Square size={15} />}
              </button>

              <span className={`flex-1 min-w-0 text-sm truncate ${
                item.done ? 'text-[#A09080] line-through' : 'text-[#3D2B1F]'
              }`}>
                {item.title}
              </span>

              {/* 谁负责这一条。未指定时是淡色的 "Anyone" —— 不是「没人做」,是「还没人认领」。 */}
              <div className="flex items-center gap-1.5 flex-shrink-0">
                {item.assignee && (
                  <Avatar name={item.assignee.name} avatar={item.assignee.avatar} size="sm" />
                )}
                <select
                  value={item.assigned_to ?? ''}
                  onChange={e => assign(item, e.target.value)}
                  aria-label={`Owner of "${item.title}"`}
                  className={`max-w-[7.5rem] px-1.5 py-1 rounded-lg border border-[#D4C5B0] bg-white text-xs focus:outline-none focus:ring-2 focus:ring-[#C4813A40] ${
                    item.assigned_to ? 'text-[#3D2B1F]' : 'text-[#A09080]'
                  }`}
                >
                  <option value="">Anyone</option>
                  {allStaff.map(s => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>

              <button
                type="button"
                onClick={() => remove(item)}
                aria-label={`Delete "${item.title}"`}
                className="text-[#A09080] hover:text-[#9E4A30] flex-shrink-0"
              >
                <X size={13} />
              </button>
            </li>
          ))}
          {total === 0 && <li className="text-xs text-[#A09080] px-2">No checklist items yet</li>}
        </ul>
      )}

      <div className="flex gap-2">
        <input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key !== 'Enter') return
            e.preventDefault()
            add()
          }}
          placeholder="Add an item…"
          className="flex-1 min-w-0 px-3 py-2 rounded-lg border border-[#D4C5B0] bg-white text-sm text-[#3D2B1F] focus:outline-none focus:ring-2 focus:ring-[#C4813A40]"
        />
        <button
          type="button"
          onClick={add}
          disabled={saving || !draft.trim()}
          className="px-3 py-2 rounded-lg bg-[#EDE5D8] text-[#8B7355] text-xs font-semibold hover:bg-[#E0D5C5] transition-colors disabled:opacity-50"
        >
          {saving ? 'Adding...' : 'Add'}
        </button>
      </div>
    </div>
  )
}
