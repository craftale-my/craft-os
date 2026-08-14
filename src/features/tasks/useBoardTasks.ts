import { useCallback, useEffect, useState } from 'react'
import { needsRebalance, openChecklistCount, rebalance } from '../../shared/lib/tasks'
import { fetchAssignableStaff, fetchBoardTasks, fetchTags, moveTask, updateTask } from './api'
import type { MoveResult, StaffLite, Tag, Task, TaskStatus } from './types'

/**
 * 子项没做完就要收工时的软性提醒。刻意**不硬挡**:子项可能作废、可能被
 * 情势跳过,硬挡会让那个任务永远结不掉,最后大家学会绕过整套 checklist。
 * 问一次就好,回 true 表示放行。
 *
 * 用 window.confirm 是跟着这个模块既有的破坏性确认走(删任务、删标签),
 * 不为了一句提示新开一层 modal —— 详情弹窗已经是 z-50,再叠一层要自己
 * 处理层级与焦点。测试端以 vi.spyOn(window, 'confirm') 决定按下确定或取消。
 */
function confirmDoneWithOpenItems(task: Task): boolean {
  const open = openChecklistCount(task)
  if (open === 0) return true
  return window.confirm(
    `Still ${open} of ${task._checklist_total} items open. Mark as done anyway?`,
  )
}

/**
 * 一块看板的资料与搬动逻辑。`/team/tasks` 与 `/team/projects/:id` 是同一块板,
 * 只差在读的范围,所以这些规则(乐观更新、回滚、软性完成闸门、整栏重新编号、
 * 错误横幅)只能有一份 —— 复制一份到专案页,两边迟早会对同一件事有两种说法。
 *
 * 回传的 `tasks` 一律是这块板的**完整**清单,不含页面层的筛选:栏尾要算在
 * 完整的那一栏上(见 TaskBoard 的 requestMove 与 bottomPosition)。页面层要筛
 * 就自己筛一份传给 TaskBoard 的 `tasks`,把这里这份原样传给 `allTasks`。
 *
 * 搬动刻意开两个口,不是为了方便:
 *  · `handleMove` —— 板上的拖放与 mobile 换栏钮,失败写进页面横幅。
 *  · `moveOptimistic` —— 详情弹窗的 "Move to",把 MoveResult 原样回传。弹窗是
 *    fixed inset-0 z-50,整个盖住页面横幅,失败讯息得进它自己的错误位才看得到。
 * 少了后者,弹窗只能把失败讲在一块使用者看不到的地方;少了前者,每个页面都要
 * 自己写一次「失败要说在哪」。
 */
export interface BoardTasks {
  /** 这块板的完整任务清单(专案页 = 该专案的全部)。 */
  tasks: Task[]
  /** 指派下拉共用的名单;读失败会顶上 error,不会退化成空清单。 */
  allStaff: StaffLite[]
  allTags: Tag[]
  /** 只有第一次进板为 true —— 全屏 loader 只能挡这一次,背景重拉不得卸载整棵树。 */
  firstLoad: boolean
  error: string
  load: () => Promise<void>
  handleMove: (taskId: string, status: TaskStatus, position: number) => Promise<void>
  moveOptimistic: (taskId: string, status: TaskStatus, position: number) => Promise<MoveResult>
}

export function useBoardTasks(projectId?: string): BoardTasks {
  const [tasks,     setTasks]     = useState<Task[]>([])
  const [allStaff,  setAllStaff]  = useState<StaffLite[]>([])
  const [allTags,   setAllTags]   = useState<Tag[]>([])
  const [firstLoad, setFirstLoad] = useState(true)
  const [error,     setError]     = useState('')

  /**
   * 重新拉板。刻意不切任何「读取中」旗标 —— 全屏 loader 只属于第一次进板。
   * 这个函式同时是 onSaved / onChanged / onPosted 的回呼,一旦它让整棵树卸载,
   * 开着的详情弹窗会跟着重挂,使用者刚打好、还没存档的内容就这样消失。
   *
   * 三笔读取全部失败就 throw(定义见 api.ts)——旧版直接摆一句
   * supabase.from('staff')...、不查 error,staff 读不到时下拉只剩 "Unassigned",
   * 使用者编辑既有任务再存档,原本的 assignee 就被无声洗成 null。三笔任何一笔
   * 失败都要让下面这个 catch 接到,板才会显示错误横幅而不是一块「看起来正常」
   * 的空清单。
   */
  const load = useCallback(async () => {
    try {
      const [t, s, g] = await Promise.all([
        fetchBoardTasks({ projectId }),
        fetchAssignableStaff(),
        fetchTags(),
      ])
      setTasks(t)
      setAllStaff(s)
      setAllTags(g)
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load tasks.')
    } finally {
      setFirstLoad(false)
    }
  }, [projectId])

  useEffect(() => { load() }, [load])

  /**
   * 乐观换栏。RLS 静默挡掉的写入没有 error 也没有 rows,所以一定要看 WriteOutcome。
   * 结果原样回传,不自己决定错误显示在哪 —— 详情弹窗那条路要自己接。
   *
   * 软性完成闸门也放在这里,而不是拖放与弹窗各写一份:板上拖放、mobile 的
   * 换栏钮、详情弹窗的 "Move to" 三条路最后都收敛到这一个函式(弹窗那条
   * 刻意绕过 handleMove,见页面层的 onStatusChange),放在这里才没有一条
   * 路径能绕过确认。确认必须挡在乐观更新之前 —— 按了取消却让卡片先跳去
   * Done 再弹回来,等於没问。
   */
  async function moveOptimistic(
    taskId: string, status: TaskStatus, position: number,
  ): Promise<MoveResult> {
    const before = tasks.find(t => t.id === taskId)
    if (!before) return { ok: false, reason: 'it is no longer on the board.' }
    // 只在「真的把任务收掉」时问 —— 已经在 Done 的卡在栏内换个位置不是收工,
    // 每挪一次就问一次「还有子项没做完」,问的是一件早就发生过的事。
    if (status === 'done' && before.status !== 'done' && !confirmDoneWithOpenItems(before)) {
      return null
    }
    setTasks(prev => prev.map(t => (t.id === taskId ? { ...t, status, position } : t)))

    const res = await moveTask(taskId, status, position)
    if (!res.ok) {
      setTasks(prev => prev.map(t => (
        t.id === taskId ? { ...t, status: before.status, position: before.position } : t
      )))
      return res
    }
    // 详情弹窗的换栏钮直接呼叫这里,不经过 handleMove —— 若不在这收掉,
    // 之前拖放失败留下的页面横幅会一直挂著,即使这次换栏明明成功了。
    setError('')

    // 目标栏搬进来之后长这样。用整份 tasks(不是画面上筛过的那份)——
    // 重新编号会重写整栏,被筛掉的卡也在里面,漏算它们就会算出错的号码。
    const column = [
      ...tasks.filter(t => t.status === status && t.id !== taskId),
      { ...before, status, position },
    ].sort((a, b) => a.position - b.position)
    if (needsRebalance(column.map(t => t.position))) await rebalanceColumn(column)
    return res
  }

  /**
   * 整栏重新编号。反覆往同一条缝插中点,double 的间距最后会小到再也切不开
   * (needsRebalance 就是在喊这件事),这时把整栏摊回 POSITION_STEP 的间距。
   *
   * 这是搬动成功之后的收尾,不是搬动本身:使用者要的那一步已经落地了,所以这里
   * 失败不能讲成「搬不动」。写入一笔一笔送、第一笔失败就停手 —— 而**由下往上**
   * 送这件事是刻意的:rebalance() 把整段新号码排在这一栏现有最大号之上,所以每
   * 一笔新号码都大于所有还没改到的旧号码、也小于已经改好的那几张。写到哪停手,
   * 整栏的顺序都还是使用者刚刚看到的那个顺序;停手留下的只是「号码还挤着」,
   * 下一次搬动会再喊一次 needsRebalance,不是「顺序被打乱」这种没人救得回来的
   * 状态。(由上往下送就会:第一张拿到的新号码可能比下面那些还没改的旧号码大。)
   *
   * 顺序虽然保住了,本地那份号码已经新旧混着、无从推测,所以照样重新拉板让画面
   * 回到资料库真正的样子,再把没收干净这件事讲出来。
   *
   * 每一张都要写:新号码一律在现有最大号之上,不可能有哪一张的号码「本来就对」。
   */
  async function rebalanceColumn(column: Task[]) {
    const planned = rebalance(column)
    for (let i = planned.length - 1; i >= 0; i--) {
      const res = await updateTask(planned[i].id, { position: planned[i].position })
      if (!res.ok) {
        // load() 成功会自己清掉 error,所以讯息要摆在它之后;代价是万一连重拉
        // 都失败,读取的错误会被这一句盖掉 —— 横幅上的 Retry 仍然是同一颗钮。
        await load()
        setError(`Could not tidy up the column order — ${res.reason}`)
        return
      }
    }
    // 全部落地了,本地直接吃新号码,不必再为了这件事多拉一次板。
    setTasks(prev => prev.map(t => {
      const next = planned.find(p => p.id === t.id)
      return next ? { ...t, position: next.position } : t
    }))
  }

  /**
   * 板上的拖放与 mobile 换栏钮 —— 失败回报到页面横幅。
   *
   * 成功刻意**不**在这里收横幅:moveOptimistic 一成功就收掉了,收完之后还接着
   * 整栏重新编号,那一步失败会把讯息写进同一条横幅。这里若再无条件清一次,
   * 就会把刚写上去的那句抹掉 —— 使用者看到的是一块什么都没说、顺序却和资料库
   * 对不起来的板。
   */
  async function handleMove(taskId: string, status: TaskStatus, position: number) {
    const res = await moveOptimistic(taskId, status, position)
    if (!res) return   // 确认被取消 —— 什么都没发生,横幅维持原样。
    if (!res.ok) setError(`Could not move the task — ${res.reason}`)
  }

  return { tasks, allStaff, allTags, firstLoad, error, load, handleMove, moveOptimistic }
}
