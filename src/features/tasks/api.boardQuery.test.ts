// 两笔「送出去的查询长什么样」的约定,元件层照不到:那一层整包 mock 掉 ./api,
// 看到的是测试自己写的假函式。所以这里跟 api.reads.test.ts 同一个做法 —— 让
// ./api 跑真的,只把 supabase client 换成假的,并记下每一次 select / eq。
//
// 1. `fetchBoardTasks({ projectId })` 一定要送出 .eq('project_id', id)。
//    /team/projects/:id 整页的前提就是这一条:漏掉的话专案页会画出全公司的
//    任务,而画面上没有任何一个地方说得出这块板其实没有被筛过 —— 每一张卡都
//    是真的,只是不属於这个专案。
//
// 2. `fetchAssignableStaff()` 只查它型别上讲得出口的那几栏。这支查询曾经把
//    五栏的结果硬转成二十几栏的 Staff,呼叫端写 staff.email 会拿到 undefined
//    而型别检查一声都不吭;现在回传 StaffLite,这里钉住 select 与型别同步 ——
//    要多的栏位就两边一起改,不能只改一边。
import { describe, it, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => {
  const selects: string[] = []
  const eqs: Array<[string, unknown]> = []

  interface Chain {
    select: (cols: string) => Chain
    eq: (col: string, val: unknown) => Chain
    or: () => Chain
    order: () => Chain
    then: (onOk: (r: { data: unknown[]; error: null }) => unknown) => Promise<unknown>
  }

  function builder(): Chain {
    const self: Chain = {
      select: cols => { selects.push(cols); return self },
      eq: (col, val) => { eqs.push([col, val]); return self },
      or: () => self,
      order: () => self,
      then: onOk => Promise.resolve({ data: [], error: null }).then(onOk),
    }
    return self
  }

  return {
    supabase: { from: () => builder() },
    selects,
    eqs,
    reset() { selects.length = 0; eqs.length = 0 },
  }
})

vi.mock('../../shared/lib/supabase', () => ({ supabase: h.supabase }))

const api = await import('./api')

beforeEach(() => h.reset())

describe('fetchBoardTasks 的专案范围', () => {
  it('filters the board down to one project', async () => {
    await api.fetchBoardTasks({ projectId: 'proj-1' })

    expect(h.eqs).toEqual([['project_id', 'proj-1']])
  })

  it('asks for every project when no projectId is given', async () => {
    await api.fetchBoardTasks()

    // 反向的守门:少了这一条,把 .eq 写死成永远送出去也会全绿,
    // 而 /team/tasks 会变成一块永远查不到东西的空板。
    expect(h.eqs).toEqual([])
  })

  it('treats an absent projectId the same as no options at all', async () => {
    // 页面层不必自己分岔:useBoardTasks 一律送 { projectId },
    // /team/tasks 那边它就是 undefined。
    await api.fetchBoardTasks({ projectId: undefined })

    expect(h.eqs).toEqual([])
  })
})

describe('fetchAssignableStaff 查的栏位', () => {
  it('selects exactly the columns its return type promises', async () => {
    await api.fetchAssignableStaff()

    expect(h.selects).toEqual(['id,name,avatar'])
  })
})
