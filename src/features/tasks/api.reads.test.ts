// api.ts 的每一支读取都必须「失败就 throw」——这是这个模块重建时立下的第一条硬
// 规则(写在 api.ts 顶端)。旧版用一句裸 `if (data)`、连 else 都没有,於是 tasks
// 表在这个 Supabase project 里根本不存在,看板照样画出一块空的 Kanban,画了好几
// 个月没人发现:「读不到」跟「真的没有资料」在画面上长得一模一样。
//
// 这条规则原本没有任何测试守着。把 fetchChecklist 里的
// `if (error) throw new Error(error.message)` 换成 `if (error) return []`,整套
// 173 个测试仍然全绿 —— 没跑迁移的环境会在每一张卡看到 "No checklist items yet",
// 上线之后任何一次 RLS 收紧都会无声清空所有人的子项,连一行错误都不会有。
//
// 元件层照不到这一层:ChecklistEditor.test.tsx 整包 mock 掉 ./api,它看到的
// fetchChecklist 是测试自己写的假函式,api.ts 里怎么处理 error 不在它的视野内。
// 所以这里跟 api.tags.test.ts / api.checklist.test.ts 同一个做法:让 ./api 跑真
// 的,只把 supabase client 换成假的。
//
// 读取不只一种形状,分开测,不套同一个模板:
//   · 单一查询 —— 七个入口,表格驱动。
//   · Promise.all 两笔(fetchProjects / fetchProject)—— 任何一笔失败都要 reject。
//     只测第一笔的话,第二笔的 error 处理整段拿掉都不会红。
//   · .single() / .maybeSingle()(fetchProject、upsertTag)—— maybeSingle 的
//     「查无此列」是 data: null / error: null,那是正常状态,不能跟 error 混为一谈;
//     .single() 的查无此列则是 PGRST116 error,必须炸出来。
import { describe, it, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => {
  interface Result {
    data: unknown
    error: { message: string; code?: string } | null
  }

  /** PostgREST 的 query builder:select/eq/or/order 一路回自己,await 才送出。
   *  它本来就是 thenable —— fetchProjects 的 `.from('project_progress').select('*')`
   *  就是直接 await、后面没有再接 .order(),假的这一份也必须是这个形状。 */
  interface Chain {
    select: () => Chain
    eq: () => Chain
    or: () => Chain
    order: () => Chain
    single: () => Promise<Result>
    maybeSingle: () => Promise<Result>
    then: (onOk: (r: Result) => unknown) => Promise<unknown>
  }

  /** 这一轮哪些 relation 要回 error。key 是资料表 / view 名,或 `rpc:<函式名>`。 */
  const failing = new Map<string, string>()
  /** 这一轮各 relation 手上有哪些列。 */
  const rows = new Map<string, unknown[]>()
  /** 实际送出去的 relation,依序 —— 用来证明 Promise.all 的两笔真的都发了。 */
  const queried: string[] = []

  function result(rel: string, mode: 'many' | 'one' | 'maybe'): Result {
    const failure = failing.get(rel)
    if (failure) return { data: null, error: { message: failure } }

    const got = rows.get(rel) ?? []
    if (mode === 'many') return { data: got, error: null }
    if (got.length > 0) return { data: got[0], error: null }
    // 查无此列:.single() 回 PGRST116 error,.maybeSingle() 回 data: null 而没有 error。
    return mode === 'one'
      ? {
          data: null,
          error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' },
        }
      : { data: null, error: null }
  }

  function builder(rel: string): Chain {
    queried.push(rel)
    const self: Chain = {
      select: () => self,
      eq: () => self,
      or: () => self,
      order: () => self,
      single: async () => result(rel, 'one'),
      maybeSingle: async () => result(rel, 'maybe'),
      then: onOk => Promise.resolve(result(rel, 'many')).then(onOk),
    }
    return self
  }

  const supabase = {
    from: (table: string) => builder(table),
    rpc: (fn: string) => builder(`rpc:${fn}`),
  }

  return {
    supabase,
    queried,
    /** 这个 relation 这一轮读起来会失败。 */
    fails(rel: string, message: string) { failing.set(rel, message) },
    /** 这个 relation 这一轮手上有这些列。 */
    holds(rel: string, got: unknown[]) { rows.set(rel, got) },
    reset() { failing.clear(); rows.clear(); queried.length = 0 },
  }
})

vi.mock('../../shared/lib/supabase', () => ({ supabase: h.supabase }))

const api = await import('./api')

/** 迁移没跑的环境实际会收到的讯息 —— 也就是当初整块板变空白的那一种。 */
const BOOM = 'relation "public.task_checklist_items" does not exist'

beforeEach(() => h.reset())

// ── 单一查询的读取 ───────────────────────────────────────────────────────────

const SINGLE_QUERY_READS: Array<{
  name: string
  relation: string
  run: () => Promise<unknown[]>
}> = [
  { name: 'fetchBoardTasks',                   relation: 'tasks',                run: () => api.fetchBoardTasks() },
  { name: 'fetchBoardTasks (one project)',     relation: 'tasks',                run: () => api.fetchBoardTasks({ projectId: 'proj-1' }) },
  { name: 'fetchArchivedTasks',                relation: 'tasks',                run: () => api.fetchArchivedTasks() },
  { name: 'fetchTags',                         relation: 'tags',                 run: () => api.fetchTags() },
  { name: 'fetchChecklist',                    relation: 'task_checklist_items', run: () => api.fetchChecklist('task-1') },
  { name: 'fetchAttachments',                  relation: 'task_attachments',     run: () => api.fetchAttachments('task-1') },
  { name: 'fetchComments',                     relation: 'task_comments',        run: () => api.fetchComments('task-1') },
]

describe.each(SINGLE_QUERY_READS)('$name:读不到就 throw,不得退化成空清单', ({ relation, run }) => {
  it('rejects with the database message instead of returning an empty list', async () => {
    h.fails(relation, BOOM)

    // 关键是 rejects 而不是 resolves([]):一个空阵列会被画成「这里本来就没东西」,
    // 使用者与 operator 都不会知道有一笔查询失败了。
    await expect(run()).rejects.toThrow(BOOM)
  })

  it('still hands back the rows when the query succeeds', async () => {
    h.holds(relation, [{ id: 'row-1' }])

    // 反向的守门:少了这一条,把整支读取改成「无论如何都 throw」也会全绿。
    // 同时钉住上面那一栏 relation 名字没写错——写错的话这里会拿到零列。
    await expect(run()).resolves.toHaveLength(1)
  })
})

// ── Promise.all 两笔的读取 ───────────────────────────────────────────────────

describe('fetchProjects:两笔查询,任何一笔失败都要 throw', () => {
  const PROJECT = { id: 'proj-1', name: 'Beans' }
  const PROGRESS = { project_id: 'proj-1', total_tasks: 7, done_tasks: 3, overdue_tasks: 1 }

  it('rejects when the projects query errors', async () => {
    h.fails('projects', 'permission denied for table projects')

    await expect(api.fetchProjects()).rejects.toThrow(/permission denied for table projects/)
  })

  it('rejects when the project_progress view errors, even though the projects came back', async () => {
    h.holds('projects', [PROJECT])
    h.fails('project_progress', 'permission denied for view project_progress')

    // 只看第一笔的话,专案清单会照常列出来,每一张卡的进度条整排归零 ——
    // 看起来就像「大家都还没开始做」。
    await expect(api.fetchProjects()).rejects.toThrow(/permission denied for view project_progress/)
    expect(h.queried).toEqual(['projects', 'project_progress'])
  })

  it('merges the progress row in when both queries succeed', async () => {
    h.holds('projects', [PROJECT])
    h.holds('project_progress', [PROGRESS])

    const [proj] = await api.fetchProjects()
    expect(proj).toMatchObject({ id: 'proj-1', total_tasks: 7, done_tasks: 3, overdue_tasks: 1 })
  })

  it('counts a project with no progress row as zero — that is not a failure', async () => {
    h.holds('projects', [PROJECT])
    h.holds('project_progress', [])

    const [proj] = await api.fetchProjects()
    expect(proj).toMatchObject({ total_tasks: 0, done_tasks: 0, overdue_tasks: 0 })
  })
})

// ── .single() / .maybeSingle() 的读取 ────────────────────────────────────────

describe('fetchProject:.single() 与 .maybeSingle(),两种「没有列」不是同一件事', () => {
  const PROJECT = { id: 'proj-1', name: 'Beans' }

  it('rejects when the project row cannot be read', async () => {
    h.fails('projects', 'permission denied for table projects')

    await expect(api.fetchProject('proj-1')).rejects.toThrow(/permission denied for table projects/)
  })

  it('rejects when there is no such project — .single() calls that PGRST116', async () => {
    h.holds('projects', [])

    // 这一支的回传型别是 Project,不是 Project | null:查无此专案只能是错误,
    // 不然呼叫端会拿着一个每一栏都是 undefined 的物件继续画页面。
    await expect(api.fetchProject('proj-1')).rejects.toThrow(/multiple \(or no\) rows/)
  })

  it('rejects when the progress view errors', async () => {
    h.holds('projects', [PROJECT])
    h.fails('project_progress', 'permission denied for view project_progress')

    // 吞掉这一笔的话,专案页会把「读不到进度」画成一个 0/0 的空专案 ——
    // 而 fetchProjects 在同样情况下是丢错误的,同一份资料两个页面两种说法。
    await expect(api.fetchProject('proj-1')).rejects.toThrow(/permission denied for view project_progress/)
    expect(h.queried).toEqual(['projects', 'project_progress'])
  })

  it('does not confuse a genuinely absent progress row with a failed one', async () => {
    h.holds('projects', [PROJECT])
    h.holds('project_progress', [])

    // .maybeSingle() 查无此列回 data: null / error: null —— 一个还没有任何任务的
    // 新专案就是长这样,counts 归 0 是对的,不该 throw。
    const proj = await api.fetchProject('proj-1')
    expect(proj).toMatchObject({ id: 'proj-1', total_tasks: 0, done_tasks: 0, overdue_tasks: 0 })
  })

  it('merges the counts when the progress row is there', async () => {
    h.holds('projects', [PROJECT])
    h.holds('project_progress', [{ project_id: 'proj-1', total_tasks: 7, done_tasks: 3, overdue_tasks: 1 }])

    const proj = await api.fetchProject('proj-1')
    expect(proj).toMatchObject({ total_tasks: 7, done_tasks: 3, overdue_tasks: 1 })
  })
})

// ── 唯一不经 writeOutcome 的写入 ─────────────────────────────────────────────

describe('upsertTag:靠 .single() 的 error 顶着,不是靠 writeOutcome', () => {
  // 严格说这是写入,但它跟读取共用同一条契约:回传的是资料列而不是 WriteOutcome,
  // 所以失败只能用 throw 表达。api.tags.test.ts 测的是撞 slug 的语义(先写入者的
  // name / created_by 不被盖掉),没有测这条错误路径。
  it('rejects when the rpc itself errors', async () => {
    h.fails('rpc:upsert_tag', 'permission denied for function upsert_tag')

    await expect(api.upsertTag('Urgent', 'staff-1')).rejects.toThrow(/permission denied for function/)
  })

  it('rejects when RLS filters the returned row away', async () => {
    h.holds('rpc:upsert_tag', [])

    // 零列 → PGRST116。吞掉的话呼叫端会拿到 null,attachTag 就带着一个
    // undefined 的 tag id 送出去,标签看起来加上了,重整之后不见。
    await expect(api.upsertTag('Urgent', 'staff-1')).rejects.toThrow(/multiple \(or no\) rows/)
  })

  it('returns the row when the rpc succeeds', async () => {
    h.holds('rpc:upsert_tag', [{ id: 'tag-1', slug: 'urgent', name: 'Urgent', color: '#8B7355' }])

    await expect(api.upsertTag('Urgent', 'staff-1')).resolves.toMatchObject({ id: 'tag-1', slug: 'urgent' })
  })
})
