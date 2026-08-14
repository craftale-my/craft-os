// Project 的三支写入是「送去 Postgres 的那笔查询长什么样」,不是 UI 行为,
// 所以这里让 ./api 跑真的,只把 supabase client 换成假的 —— 跟 api.tags.test.ts /
// api.checklist.test.ts 同一个理由:mock 掉 ./api 只能证明呼叫端转发了参数,
// 证明不了 api.ts 组出了什么。
//
// 这一层要钉住两件事:
//  1. 每一笔写入都要带 .select()。假的 client 只在 .select() 之后才回资料列,
//     少了它 writeOutcome 拿到的东西不成形状,成功的案例会红。
//  2. RLS 挡掉的写入回 { data: [], error: null } —— 没有 error 也没有列。
//     只看 error 就会跟使用者说「建立好了」,其实一个字都没写进去。
import { describe, it, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => {
  /** 实际送出的写入,依序。 */
  const calls: Array<{ op: 'insert' | 'update' | 'delete'; table: string; payload?: unknown; id?: string }> = []
  /** true 时一律回 RLS 挡掉的形状。 */
  let rlsBlocks = false
  /** 这一轮写入要回的 error(优先于 rlsBlocks)。 */
  let failure: string | null = null

  function settle(row: unknown) {
    if (failure) return { data: null, error: { message: failure } }
    if (rlsBlocks) return { data: [], error: null }
    return { data: [row], error: null }
  }

  const supabase = {
    from(table: string) {
      return {
        insert(payload: Record<string, unknown>) {
          calls.push({ op: 'insert', table, payload })
          return { async select() { return settle({ id: 'proj-new', ...payload }) } }
        },
        update(payload: Record<string, unknown>) {
          return {
            eq(_col: string, id: string) {
              void _col
              calls.push({ op: 'update', table, payload, id })
              return { async select() { return settle({ id, ...payload }) } }
            },
          }
        },
        delete() {
          return {
            eq(_col: string, id: string) {
              void _col
              calls.push({ op: 'delete', table, id })
              return { async select() { return settle({ id }) } }
            },
          }
        },
      }
    },
  }

  return {
    supabase, calls,
    blockWrites(on: boolean) { rlsBlocks = on },
    failWith(msg: string) { failure = msg },
    reset() { calls.length = 0; rlsBlocks = false; failure = null },
  }
})

vi.mock('../../shared/lib/supabase', () => ({ supabase: h.supabase }))

const api = await import('./api')

const INPUT = {
  name: 'Bean Sourcing',
  description: null,
  color: '#C4813A',
  status: 'active' as const,
  owner_id: 'staff-2',
  start_date: null,
  due_date: null,
}

beforeEach(() => h.reset())

describe('createProject', () => {
  it('inserts into projects with created_by stamped on, and reports the write landed', async () => {
    await expect(api.createProject(INPUT, 'staff-1')).resolves.toEqual({ ok: true })
    expect(h.calls).toEqual([
      { op: 'insert', table: 'projects', payload: { ...INPUT, created_by: 'staff-1' } },
    ])
  })

  it('reports failure when RLS returns no error and no rows', async () => {
    h.blockWrites(true)

    // 这正是 writeOutcome 存在的理由:error === null 不代表写进去了。
    await expect(api.createProject(INPUT, 'staff-1')).resolves.toEqual({
      ok: false,
      reason: 'it was not saved — you may have been signed out.',
    })
  })

  it('passes the database message through when the insert really errors', async () => {
    h.failWith('new row violates row-level security policy for table "projects"')

    await expect(api.createProject(INPUT, 'staff-1')).resolves.toEqual({
      ok: false,
      reason: 'new row violates row-level security policy for table "projects"',
    })
  })
})

describe('updateProject', () => {
  it('targets the one row and reports success', async () => {
    await expect(api.updateProject('proj-1', { status: 'on_hold' })).resolves.toEqual({ ok: true })
    expect(h.calls).toEqual([
      { op: 'update', table: 'projects', payload: { status: 'on_hold' }, id: 'proj-1' },
    ])
  })

  it('reports failure when RLS filters the updated row away', async () => {
    h.blockWrites(true)

    await expect(api.updateProject('proj-1', { status: 'on_hold' })).resolves.toMatchObject({ ok: false })
  })
})

describe('deleteProject', () => {
  it('deletes the one row and reports success', async () => {
    await expect(api.deleteProject('proj-1')).resolves.toEqual({ ok: true })
    expect(h.calls).toEqual([{ op: 'delete', table: 'projects', id: 'proj-1' }])
  })

  it('reports failure when RLS silently deletes nothing', async () => {
    h.blockWrites(true)

    // 静静地什么都没删,页面却收掉专案 —— 重整之后它又回来了。
    await expect(api.deleteProject('proj-1')).resolves.toMatchObject({ ok: false })
  })
})
