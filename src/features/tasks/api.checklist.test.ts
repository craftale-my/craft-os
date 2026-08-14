// 子项负责人的读写是「送去 Postgres 的那笔查询长什么样」,不是 UI 行为,
// 所以这里让 ./api 跑真的,只把 supabase client 换成假的 —— 跟 api.tags.test.ts /
// api.updateTag.test.ts 同一个理由:mock 掉 ./api 只能证明呼叫端把参数转发出去,
// 证明不了 api.ts 组出了什么。这个模块前面就出过一次「测试 mock 了 ./api,
// 於是查询本身写错也全绿」的 review 漏网。
//
// 两件事在这一层才照得到:
//  1. 读取必须真的把 assigned_to 与内嵌的 staff 列要回来。少了它,画面上每一条
//     子项都会永远显示 "Anyone",资料库里明明有人认领 —— 而且不会有任何错误。
//  2. 写入必须带 .select() 并经 writeOutcome 判定。RLS 挡掉的写入回
//     { data: [], error: null },没有 error 也没有列;只看 error 就会跟使用者说
//     「已认领」,其实一个字都没写进去。
import { describe, it, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => {
  interface ItemRow {
    id: string
    task_id: string
    title: string
    done: boolean
    position: number
    assigned_to: string | null
  }

  const items: ItemRow[] = []
  /** 每一次读取实际送出的 select 字串。 */
  const selects: string[] = []
  /** 每一次更新实际送出的 patch。 */
  const updates: Record<string, unknown>[] = []
  /** true 时 update 一律回 RLS 挡掉的形状:没有 error,也没有列。 */
  let rlsBlocks = false

  const supabase = {
    from(table: string) {
      if (table !== 'task_checklist_items') {
        throw new Error(`unexpected table in this test: ${table}`)
      }
      return {
        select(cols: string) {
          selects.push(cols)
          return {
            eq(col: keyof ItemRow, val: string) {
              return {
                async order(_by: string) {
                  void _by
                  return { data: items.filter(r => r[col] === val), error: null }
                },
              }
            },
          }
        },

        update(patch: Record<string, unknown>) {
          updates.push(patch)
          return {
            eq(col: keyof ItemRow, val: string) {
              return {
                async select() {
                  if (rlsBlocks) return { data: [], error: null }
                  const row = items.find(r => r[col] === val)
                  if (!row) return { data: [], error: null }
                  Object.assign(row, patch)
                  return { data: [{ ...row }], error: null }
                },
              }
            },
          }
        },
      }
    },
  }

  return {
    items, selects, updates, supabase,
    blockWrites(on: boolean) { rlsBlocks = on },
    reset() {
      items.length = 0
      selects.length = 0
      updates.length = 0
      rlsBlocks = false
      items.push({
        id: 'item-1', task_id: 'task-1', title: 'Count the bean bags',
        done: false, position: 1024, assigned_to: null,
      })
    },
  }
})

vi.mock('../../shared/lib/supabase', () => ({ supabase: h.supabase }))

const { fetchChecklist, setChecklistAssignee } = await import('./api')

beforeEach(() => { h.reset() })

describe('fetchChecklist:负责人必须真的被查回来', () => {
  it('asks for the assigned_to column', async () => {
    await fetchChecklist('task-1')
    expect(h.selects[0]).toMatch(/\bassigned_to\b/)
  })

  it('embeds the staff row through the assigned_to foreign key', async () => {
    await fetchChecklist('task-1')
    // 指名外键:task_checklist_items 现在同时指向 tasks 与 staff,PostgREST 会
    // 把这种「两个外键」的表当成多对多中介表,裸写 staff(...) 迟早撞上歧义。
    expect(h.selects[0]).toMatch(/assignee:staff!task_checklist_items_assigned_to_fkey\(/)
  })
})

describe('setChecklistAssignee:写的是 assigned_to,而且要看得出有没有落地', () => {
  it('writes the staff id onto that one row', async () => {
    const res = await setChecklistAssignee('item-1', 'staff-2')

    expect(res.ok).toBe(true)
    expect(h.updates).toEqual([{ assigned_to: 'staff-2' }])
    expect(h.items[0].assigned_to).toBe('staff-2')
  })

  it('clears the owner with null, not an empty string', async () => {
    await setChecklistAssignee('item-1', 'staff-2')
    await setChecklistAssignee('item-1', null)

    // assigned_to 是 uuid 栏位:送 '' 进去 Postgres 会回 22P02
    // (invalid input syntax for type uuid),放回 "Anyone" 就永远失败。
    expect(h.updates[1]).toEqual({ assigned_to: null })
    expect(h.items[0].assigned_to).toBeNull()
  })

  it('reports a failure when RLS silently drops the write', async () => {
    h.blockWrites(true)

    const res = await setChecklistAssignee('item-1', 'staff-2')

    // { data: [], error: null } —— 没有 error,也没有列。
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.reason).toMatch(/not saved/i)
  })

  it('reports a failure when the row is gone', async () => {
    const res = await setChecklistAssignee('item-gone', 'staff-2')

    expect(res.ok).toBe(false)
  })
})
