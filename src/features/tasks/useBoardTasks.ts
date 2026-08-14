import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js'
import { needsRebalance, openChecklistCount, rebalance } from '../../shared/lib/tasks'
import { supabase } from '../../shared/lib/supabase'
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
 * Realtime:另一个 session 动了 `tasks`,这块板要自己跟上,不必有人按重整。
 *
 * 事件本身不带 join 进来的 assignee / project / tags,所以收到就重拉一次,而不是
 * 就地打补丁 —— 板上最多几十张卡,一次查询比维护一整套补丁逻辑便宜太多。
 *
 * 只有 `tasks` 在 supabase_realtime publication 里。子项、附件、标签、留言的变动
 * 不订阅:那四张表的内容只在详情弹窗里看得到,而弹窗一开就自己重读一次,拿四条
 * 长驻的订阅去换「弹窗开着的时候别人刚好改了子项」这一格,不划算。
 *
 * 事件流本身不会帮你处理的三件事:
 *
 * · **回音**。自己写出去的那一笔也会广播回来。板上换栏是乐观更新,本地那份早就
 *   是对的,收到自己的回音再重拉一次只是白跑。所以每一笔自己送出去的写入都先
 *   按下一张票,回音拿票换行程,换不到才重拉。
 *
 * · **连发**。整栏重新编号是一笔一笔写的,N 张卡就是 N 个事件;别人做这件事,
 *   这块板会连收 N 发,naive 版本就是重拉 N 次板。所以收敛成一次:事件还在来就
 *   一直把计时器往后推,安静下来才真的去拉。
 *
 * · **断线**。postgres_changes 不补送断线期间的事件,而 supabase-js 会自己安静地
 *   重新 join。笔电睡二十分钟醒来,socket 接回来了,板上却还是睡前那一份 ——
 *   而且它看起来跟「线上、且是最新的」一模一样,realtime 的存在只会让人更信它。
 *   所以 channel 每次报到 SUBSCRIBED 就重拉一次。
 *
 * 另外,收到别人的事件而重拉,**不准**顺手清掉横幅上那句「你刚刚那一笔没存进去」:
 * 那句话只有使用者自己的下一个动作有资格收掉,详见 readError / writeError。
 */

/**
 * 连发收敛的等待时间(trailing debounce)。测试要照着这个数字等,所以 export ——
 * 与其在测试里抄一个会各自漂走的魔术数字,不如让两边读同一个来源。
 */
export const REALTIME_DEBOUNCE_MS = 300

/** 回音最多等这么久;超时的票要放行,理由见 EchoMarks。 */
const ECHO_TTL_MS = 5_000

/**
 * 「这一笔是我自己写的」的票。用 id → 到期时间的**队列**,不是一个布尔值:整栏
 * 重新编号会对同一块板送出好几笔写入,每一笔都要有自己的一张票,少算一张就有
 * 一发回音会漏进来白拉一次板。
 *
 * 票被认领就消掉,而不是「这段时间内该 id 的事件一律不理」—— 后者是为了自己的
 * 回音,把别人挡在门外:同一张卡在下一毫秒被别人改动,这块板就再也跟不上了。
 * TTL 只是漏接时的保险丝(realtime 断线、回音根本没送来),没有它,那张卡的票会
 * 永远挂着,等於把那张卡从 realtime 上摘掉。
 */
type EchoMarks = Map<string, number[]>

function markOwnWrite(marks: EchoMarks, taskId: string) {
  const queue = marks.get(taskId) ?? []
  queue.push(Date.now() + ECHO_TTL_MS)
  marks.set(taskId, queue)
}

/**
 * 认领一张票:认得到就消掉它并回 true(这是自己的回音,不必重拉)。
 * 写入没落地时也拿它把票收回来 —— 没写进去就不会有回音,票留着只会挡掉别人
 * 接下来对同一张卡的改动。
 */
function claimOwnWrite(marks: EchoMarks, taskId: string): boolean {
  const queue = marks.get(taskId)
  if (!queue) return false
  const now = Date.now()
  while (queue.length > 0 && queue[0] <= now) queue.shift()
  const claimed = queue.length > 0
  if (claimed) queue.shift()
  if (queue.length === 0) marks.delete(taskId)
  return claimed
}

/** 事件里那一列的 id。DELETE 只带得到 old(而且只有主键)。 */
function changedTaskId(
  payload: RealtimePostgresChangesPayload<{ id: string }>,
): string | undefined {
  const next = payload.new as { id?: string } | undefined
  const prev = payload.old as { id?: string } | undefined
  return next?.id ?? prev?.id
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
  /** 横幅上要显示的那一句(读取失败与写入失败共用一条横幅,见下面的两格状态)。 */
  error: string
  load: () => Promise<void>
  handleMove: (taskId: string, status: TaskStatus, position: number) => Promise<void>
  moveOptimistic: (taskId: string, status: TaskStatus, position: number) => Promise<MoveResult>
}

/**
 * @param projectId 只读这个专案的任务;省略就是整块 /team/tasks。
 * @param onMoved   一次搬动**真的落地**之后叫一次。给的是页面层那些「由任务算出来、
 *   却不在这块板上」的数字一个重拉的机会 —— 专案头部的 done/total/overdue 来自
 *   project_progress view(以 `status = 'done'` 计数),板上换一次栏它就过期一次。
 *
 *   做成这支 hook 的合约,而不是让每个页面在自己的 onMove 后面补一句 loadProject():
 *   漏补的那一页不会坏给你看,只会安静地把 `0/1` 与一条空的进度条,挂在一张已经
 *   躺在 Done 的卡正上方 —— 那个数字正是这一页存在的理由。搬动有两个入口
 *   (handleMove 与弹窗直接呼叫的 moveOptimistic),通知只挂在两者交会的那一点上,
 *   没有一条路径能绕过它。
 *
 *   什么时候**不**叫:软性完成确认被取消(没送出写入,也没跑乐观更新)、写入被挡
 *   下来并已回滚(status 从头到尾没变过),以及整栏重新编号之后 —— 重新编号只改
 *   position,不动 status 也不动 due_date,project_progress 的三个数字没有一个看得
 *   到它,再叫一次只是多一趟白跑的读取。
 *
 *   它必须自己吞掉自己的错误(ProjectDetail 的 loadProject 会把讯息写进自己那条
 *   横幅)。这里会 await 它,而板上的 onMove 型别是 `=> void`、没有人接这个
 *   promise,丢出来的例外会变成没人处理的 rejection。
 */
export function useBoardTasks(
  projectId?: string,
  onMoved?: () => void | Promise<void>,
): BoardTasks {
  const [tasks,     setTasks]     = useState<Task[]>([])
  const [allStaff,  setAllStaff]  = useState<StaffLite[]>([])
  const [allTags,   setAllTags]   = useState<Tag[]>([])
  const [firstLoad, setFirstLoad] = useState(true)

  /**
   * 横幅上的字分两格存,依「这句话在讲什么」分:
   *
   * · `readError`  —— 那三笔读取失败了。板上这份资料本身可疑,任何一次成功的重拉
   *   都该收掉它(不管是谁触发的),否则就是一条永远不会消失的横幅。
   * · `writeError` —— 使用者送出去的写入没落地(换栏被挡、整栏重新编号没收干净)。
   *   这句话讲的是**画面上刚刚发生的那件事**,只有使用者自己的下一个动作(再搬一次、
   *   按 Retry、弹窗里存档)有资格收掉它。别人 session 的一发事件走的是背景重拉,
   *   收得掉它的话,使用者看到的就是一张自己跳回原栏、却没人解释为什么的卡。
   *
   * 两句同时活着就先讲写入那句:使用者盯着的是自己刚做的那一步,而横幅上的 Retry
   * 是同一颗钮,读取那句被压着也不会少掉任何一个可以按的动作。
   */
  const [readError,  setReadError]  = useState('')
  const [writeError, setWriteError] = useState('')
  const error = writeError || readError

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
   *
   * @param clearWriteError 这一趟是不是使用者自己按出来的。只有使用者自己那条路
   *   可以顺手把「没存进去」那句收掉;realtime 的背景重拉传 false。
   */
  const runLoad = useCallback(async (clearWriteError: boolean) => {
    try {
      const [t, s, g] = await Promise.all([
        fetchBoardTasks({ projectId }),
        fetchAssignableStaff(),
        fetchTags(),
      ])
      setTasks(t)
      setAllStaff(s)
      setAllTags(g)
      setReadError('')
      if (clearWriteError) setWriteError('')
    } catch (e) {
      setReadError(e instanceof Error ? e.message : 'Could not load tasks.')
    } finally {
      setFirstLoad(false)
    }
  }, [projectId])

  /** 使用者自己触发的重拉:横幅的 Retry、弹窗存档 / 留言 / 改标签之后的回呼。 */
  const load = useCallback(() => runLoad(true), [runLoad])

  /** realtime 触发的背景重拉:资料要跟上,横幅上那句「没存进去」不准动。 */
  const refreshFromRealtime = useCallback(() => runLoad(false), [runLoad])

  /**
   * 换专案 = 换一块板,firstLoad 要跟着回到 true:新专案的三笔读还没落地之前,
   * 画面上的头部、板、连开着的详情弹窗都还是上一个专案的东西,而它们没有一处
   * 看得出来自己是旧的。
   *
   * 刻意钉在 projectId 这个**值**上,不是钉在 load 的身分上:load 今天的 deps
   * 只有 projectId,但只要有人往那个 useCallback 多加一个 dep,钉身分的写法就会
   * 让每一次背景重拉都升起全屏 loader,把开着的弹窗连同还没存档的内容一起卸载
   * —— 那正是这块板不准再发生的事(见 load 上方)。
   *
   * 今天从 UI 走不到这条路(专案页唯一的出口是回清单,回去再进来是重新挂载),
   * 留着是因为「换一个 :id」迟早会有第二个入口(专案切换器、上一个/下一个),
   * 而那次改动没有理由回头看这支 hook。
   */
  useEffect(() => { setFirstLoad(true) }, [projectId])

  useEffect(() => { load() }, [load])

  /**
   * 订阅那支 effect 要用的、永远最新的背景重拉 —— 但**不**把它放进 effect 的 deps。
   *
   * 钉在它的身分上,换一次 :id 就会把 WebSocket channel 拆掉重开一条;更糟的是
   * 只要有人往上面那个 useCallback 多加一个 dep,那条 channel 就会跟着每一次
   * 重新渲染退订、重订。订阅内容与 projectId 无关(见下面为什么不下 filter),
   * 一条 channel 撑完整个挂载期间就够了,所以这里钉的是「挂载」这件事本身。
   */
  const refreshRef = useRef(refreshFromRealtime)
  useEffect(() => { refreshRef.current = refreshFromRealtime }, [refreshFromRealtime])

  const echoMarks    = useRef<EchoMarks>(new Map())
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * 每个 hook 实例一条自己的 channel:两块板可能挂在同一棵树上(今天没有,但
   * 「专案页旁边再放一块我的任务」是随时会发生的一次改动),共用一个固定名字就是
   * 两个实例抢同一个 topic。
   *
   * 挡不到的是 StrictMode 的挂 → 拆 → 再挂:useId 对同一个实例回同一个 id,
   * 前后两次拿到的 topic 一模一样。那一格是靠 cleanup 里的 removeChannel 收的。
   */
  const channelKey = useId().replace(/[^a-zA-Z0-9]/g, '')

  useEffect(() => {
    const marks = echoMarks.current
    /** 退订之后到达的回呼不准再排行程 —— 那一趟会在元件卸载之后才去拉板。 */
    let live = true

    /** 连发收敛:事件还在来就一直把计时器往后推,安静下来才真的去拉。 */
    const scheduleRefresh = () => {
      if (!live) return
      if (refreshTimer.current !== null) clearTimeout(refreshTimer.current)
      refreshTimer.current = setTimeout(() => {
        refreshTimer.current = null
        // 背景重拉:不碰 firstLoad(全屏 loader 只属于第一次进板),别人搬一张卡
        // 不该让这里开着的详情弹窗连同还没存档的内容一起被卸载(见 load 上方);
        // 也不碰 writeError(见上面那两格状态)。
        void refreshRef.current()
      }, REALTIME_DEBOUNCE_MS)
    }

    const channel = supabase
      .channel(`tasks-board-${channelKey}`)
      // 刻意**不**下 `filter: 'project_id=eq.<id>'`。专案板只关心自己那些任务,但
      // postgres_changes 的 filter 比对的是事件里那一列本身,所以「把任务搬**出**
      // 这个专案」的那笔 UPDATE(新值的 project_id 已经是别人了)根本不会送来 ——
      // 那张卡会赖在这块板上直到有人手动重整,而它看起来跟一张正常的卡毫无差别。
      // 宁可多收几发全公司的事件,每一发都用 projectId 收敛过的那句查询重拉。
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'tasks' },
        (payload: RealtimePostgresChangesPayload<{ id: string }>) => {
          const taskId = changedTaskId(payload)
          if (taskId && claimOwnWrite(marks, taskId)) return   // 自己的回音
          scheduleRefresh()
        },
      )
      // 每次 channel 报到就重拉一次板。补的是事件流补不了的两道缝:
      //  · **重连**。断线期间的事件不会补送,而 supabase-js 自己重新 join 完就没了
      //    下文 —— 少了这一句,睡醒的那块板会一直停在睡前那一份,看起来却完全正常。
      //  · **挂载**。第一次读取在 join 完成之前就回来了,那段窗口里别人的改动既不在
      //    那份读取里,也不会有事件送来。所以第一次 SUBSCRIBED 也照拉,代价是进板
      //    多一次查询。
      // 走的是跟事件同一条 debounce:重连之后往往紧接着一串事件,各排各的计时器就
      // 会各拉一次板。status 收成 string —— 为了一个字面值把 supabase 的 runtime
      // enum(REALTIME_SUBSCRIBE_STATES)import 进来不划算。
      .subscribe((status: string) => {
        if (status !== 'SUBSCRIBED') return
        scheduleRefresh()
      })

    return () => {
      live = false
      // 计时器要跟着退订一起收掉,否则最后那一发事件会在元件已经卸载之后才去拉板。
      if (refreshTimer.current !== null) {
        clearTimeout(refreshTimer.current)
        refreshTimer.current = null
      }
      supabase.removeChannel(channel)
    }
  }, [channelKey])

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

    // 先按票再送出:realtime 走的是另一条连线,广播很可能比这支 await 的回应
    // 先到,写在後面就来不及认领了(见档案上方的 realtime 说明)。
    markOwnWrite(echoMarks.current, taskId)
    const res = await moveTask(taskId, status, position)
    if (!res.ok) {
      claimOwnWrite(echoMarks.current, taskId)   // 没写进去就不会有回音,票收回来
      setTasks(prev => prev.map(t => (
        t.id === taskId ? { ...t, status: before.status, position: before.position } : t
      )))
      return res
    }
    // 详情弹窗的换栏钮直接呼叫这里,不经过 handleMove —— 若不在这收掉,
    // 之前拖放失败留下的页面横幅会一直挂著,即使这次换栏明明成功了。
    // 只收写入那一句:读取失败是另一回事,它得等一次真的成功的重拉。
    setWriteError('')

    // 搬动落地了,让页面层重拉它自己那份衍生数字(合约见 useBoardTasks 上方)。
    // 摆在重新编号之前:使用者盯着的是头部那个数字,重新编号是一步看不见的收尾,
    // 先把画面讲对,再去整理号码。
    await onMoved?.()

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
      // 每一笔都要自己的一张票 —— 这一趟会送出整栏的写入,也就是整栏的回音。
      markOwnWrite(echoMarks.current, planned[i].id)
      const res = await updateTask(planned[i].id, { position: planned[i].position })
      if (!res.ok) {
        claimOwnWrite(echoMarks.current, planned[i].id)
        // load() 是使用者自己那条路,成功会顺手清掉 writeError,所以这句话仍然要
        // 摆在它之后。万一连重拉都失败,两句话都还在,横幅先讲这一句(见上面的
        // 两格状态)—— 而 Retry 仍然是同一颗钮。
        await load()
        setWriteError(`Could not tidy up the column order — ${res.reason}`)
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
    if (!res.ok) setWriteError(`Could not move the task — ${res.reason}`)
  }

  return { tasks, allStaff, allTags, firstLoad, error, load, handleMove, moveOptimistic }
}
