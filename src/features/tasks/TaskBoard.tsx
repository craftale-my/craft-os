import { useState } from 'react'
import { insertPosition } from '../../shared/lib/tasks'
import { TASK_COLUMNS } from './types'
import type { Task, TaskStatus } from './types'
import { TaskCard } from './TaskCard'

const COL_STYLE: Record<TaskStatus, {
  bg: string; border: string
  countBg: string; countColor: string; labelColor: string
}> = {
  todo:        { bg: '#FAF6F1', border: '#EDE5D8', countBg: '#EDE5D8', countColor: '#8B6344', labelColor: '#8B6344' },
  in_progress: { bg: '#EBF3FB', border: '#BDD4EC', countBg: '#D4E8F7', countColor: '#2E6E9E', labelColor: '#2E6E9E' },
  done:        { bg: '#EBF5EE', border: '#B8DCC4', countBg: '#CCE8D4', countColor: '#3D7A50', labelColor: '#3D7A50' },
}

/**
 * 一栏由上到下的卡。一律依 position 排序:乐观更新只改 position、不动阵列顺序,
 * 不在这里排的话栏内重排会完全看不出来 —— 卡片得等下一次重拉板才跳到新位置,
 * 中间那段时间画面讲的顺序和资料库讲的顺序是两回事。同一个理由,「栏尾在哪」
 * 也不能靠阵列的最后一格:那一格在乐观更新之后不一定还是号码最大的那张。
 */
function sortedIn(tasks: Task[], status: TaskStatus): Task[] {
  return tasks.filter(t => t.status === status).sort((a, b) => a.position - b.position)
}

/**
 * 该栏底部的落点。新任务、详情弹窗的 "Move to" 都用它 —— 这两条路没有
 * 「插在哪两张之间」的概念,一律进栏尾。空栏回 POSITION_STEP。
 *
 * `tasks` 必须是**整份**任务,不是画面上筛过的那份:栏尾讲的是这一栏真正的
 * 最后一张。板上「丢在栏位本体」与 mobile 的换栏钮走 TaskBoard 内部同一套
 * 规则(见 requestMove),两边算出来的栏尾因此是同一个。
 */
export function bottomPosition(tasks: Task[], status: TaskStatus): number {
  const column = sortedIn(tasks, status)
  return insertPosition(column, column.length)
}

/** 拖曳中的落点:col = 目标栏,beforeId = 插在哪一张卡之前,null = 栏尾。 */
type DropAt = { col: TaskStatus; beforeId: string | null }

/** 落点指示线。用的是栏位 dragOver 外框那支强调色,不另外开一套配色。 */
function DropLine({ edge }: { edge: 'top' | 'bottom' }) {
  return (
    <div
      className={`absolute left-1 right-1 h-[3px] rounded-full pointer-events-none ${
        edge === 'top' ? '-top-1.5' : '-bottom-1.5'
      }`}
      style={{ background: '#C4813A' }}
    />
  )
}

/**
 * 一栏。`variant` 决定 data-testid 的命名空间:桌面三栏与 mobile 单栏会同时挂在
 * DOM 上(靠 CSS 二选一显示),不套 CSS 的环境(jsdom)两边都看得到。只有桌面版
 * 那一份带真正的拖放 handler,所以只有它能用没有前缀的 `column-*` / `task-card-*`;
 * mobile 那份一律加 `mobile-` 前缀,免得测试抓到空的 no-op handler 还查不出原因。
 */
function KanbanColumn({
  variant, colKey, label, tasks, canManage, currentStaffId,
  dropAt, onDragOver, onDragLeave, onDrop, onZoneOver, onZoneDrop,
  draggingId, onDragStart, onDragEnd, onCardClick, onAddClick,
  showMobileActions, onCardStatusChange,
}: {
  variant: 'desktop' | 'mobile'
  colKey: TaskStatus
  label: string
  tasks: Task[]
  canManage: boolean
  currentStaffId: string
  /** 落点落在**这一栏**时才给,别栏一律 null —— 由 TaskBoard 先筛过。 */
  dropAt: DropAt | null
  onDragOver: (e: React.DragEvent) => void
  onDragLeave: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
  onZoneOver: (beforeId: string | null) => void
  onZoneDrop: (beforeId: string | null) => void
  draggingId: string | null
  onDragStart: (id: string) => void
  onDragEnd: () => void
  onCardClick: (task: Task) => void
  onAddClick: () => void
  showMobileActions?: boolean
  onCardStatusChange?: (taskId: string, status: TaskStatus) => void
}) {
  const s = COL_STYLE[colKey]
  const idPrefix = variant === 'mobile' ? 'mobile-' : ''
  const isDragOver = dropAt !== null

  /**
   * 插入点必须吃掉事件,不能让它冒泡到栏位本体:栏位的 handler 是「放到栏尾」,
   * 冒上去就会把刚指定的落点盖掉,细分的落点等於白做。
   */
  const zoneOver = (beforeId: string | null) => (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    onZoneOver(beforeId)
  }
  const zoneDrop = (beforeId: string | null) => (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    onZoneDrop(beforeId)
  }

  return (
    <div
      data-testid={`${idPrefix}column-${colKey}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className="flex flex-col rounded-2xl p-3 min-h-[400px] transition-all"
      style={{
        background: s.bg,
        border: `1.5px solid ${isDragOver ? '#C4813A' : s.border}`,
        boxShadow: isDragOver ? '0 0 0 3px #C4813A30' : undefined,
      }}
    >
      <div className="flex items-center justify-between mb-3 px-0.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold" style={{ color: s.labelColor }}>{label}</span>
          <span
            className="text-xs font-bold px-1.5 py-0.5 rounded-full"
            style={{ background: s.countBg, color: s.countColor }}
          >
            {tasks.length}
          </span>
        </div>
        {canManage && colKey === 'todo' && (
          <button
            onClick={onAddClick}
            className="w-6 h-6 flex items-center justify-center rounded-full bg-[#C4813A] text-white text-base font-bold leading-none hover:bg-[#A86C2C] transition-colors"
            title="New task"
          >
            +
          </button>
        )}
      </div>

      <div className="flex flex-col gap-2.5 flex-1">
        {tasks.length === 0 ? (
          <div className="flex-1 flex items-center justify-center py-10">
            <p className="text-xs text-[#A09080]">No tasks here yet</p>
          </div>
        ) : (
          tasks.map((task, i) => (
            <div key={task.id} className="relative">
              <TaskCard
                task={task}
                testIdPrefix={idPrefix}
                draggable={canManage || task.assigned_to === currentStaffId}
                isDragging={draggingId === task.id}
                onDragStart={() => onDragStart(task.id)}
                onDragEnd={onDragEnd}
                onClick={() => onCardClick(task)}
                showMobileActions={showMobileActions && (canManage || task.assigned_to === currentStaffId)}
                onStatusChange={onCardStatusChange ? status => onCardStatusChange(task.id, status) : undefined}
              />

              {/* 落点指示线。栏尾(beforeId = null)画在最后一张卡的下缘。 */}
              {dropAt?.beforeId === task.id && <DropLine edge="top" />}
              {dropAt?.beforeId === null && i === tasks.length - 1 && <DropLine edge="bottom" />}

              {/*
                插入点。刻意不是卡与卡之间那条 8px 细缝:8px 对滑鼠是个很难瞄准的
                目标,而且那条缝要占位,拖曳一开始就会把整栏往下推。改成盖在卡片上、
                各半张高的两块透明覆盖层 —— 上半 = 插在这张之前,下半 = 插在下一张
                之前(最后一张的下半就是栏尾)。命中区大了一个量级,栏位版面一格没动,
                而且每个落点都有自己的 data-testid,测试不必依赖 jsdom 量不出来的座标。

                只在拖曳进行中挂上:平时挂着会盖住卡片,连点开详情都点不到。
                mobile 那一份的 draggingId 永远是 null,所以那边根本不会长出来。

                上半那块往上多吃 gap-2.5 那 10px:两块覆盖层加起来只盖满卡片本身,
                卡与卡之间那条缝就成了没人认领的死带 —— 指标慢慢划过去,指示线会
                从「插在这里」跳成「放到栏尾」再跳回来。这块本来就把指示线画在
                -top-1.5(缝里),把命中区补到同一个地方而已。
              */}
              {draggingId !== null && (
                <>
                  <div
                    data-testid={`${idPrefix}drop-before-${task.id}`}
                    className="absolute inset-x-0 -top-2.5 bottom-1/2"
                    onDragOver={zoneOver(task.id)}
                    onDrop={zoneDrop(task.id)}
                  />
                  <div
                    data-testid={`${idPrefix}drop-after-${task.id}`}
                    className="absolute inset-x-0 bottom-0 h-1/2"
                    onDragOver={zoneOver(tasks[i + 1]?.id ?? null)}
                    onDrop={zoneDrop(tasks[i + 1]?.id ?? null)}
                  />
                </>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

/**
 * 三栏板本体。只吃传进来的清单,不自己查资料 —— 好让 `/team/tasks` 与
 * `/team/projects/:id` 共用同一块板。写入由 `onMove` 交回页面层。
 */
export function TaskBoard({
  tasks, allTasks, canManage, currentStaffId, onCardClick, onAddClick, onMove,
}: {
  /** 画面上看得到的卡 —— 页面层已经套过筛选。 */
  tasks: Task[]
  /**
   * 整份任务,没套筛选。只有「栏尾」那个落点吃它 —— 见 requestMove。
   * 页面层不筛的时候两者是同一份,拿同一个阵列传两次也完全没问题。
   */
  allTasks: Task[]
  canManage: boolean
  currentStaffId: string
  onCardClick: (task: Task) => void
  onAddClick: () => void
  onMove: (taskId: string, status: TaskStatus, position: number) => void
}) {
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<DropAt | null>(null)
  const [mobileTab, setMobileTab] = useState<TaskStatus>('todo')

  // 画面上的三栏。排序的理由见 sortedIn。
  const byCol: Record<TaskStatus, Task[]> = {
    todo:        sortedIn(tasks, 'todo'),
    in_progress: sortedIn(tasks, 'in_progress'),
    done:        sortedIn(tasks, 'done'),
  }

  /**
   * 非管理层只能搬自己名下的任务 —— 这条规则同时守住拖放与 mobile 的换栏钮。
   *
   * `beforeId` 是落点:插在目标栏的哪一张卡之前,null = 栏尾。栏位本体接到的 drop
   * 与 mobile 的换栏钮一律传 null ——「丢在这一栏上」就是「放到这一栏的最后」。
   *
   * 落点要算在哪一份清单上,看使用者指的是什么:
   *
   *  - 指名插在某张卡之前 → 算在**画面上看得到的**那一栏。有筛选时,使用者瞄准的
   *    就是这两张卡之间;被筛掉的卡还留在原本的号码上,可能夹在中间,那是筛选下
   *    重排的固有结果,拿完整清单去算反而会算出一个使用者没看过的落点。
   *
   *  - 栏尾 → 算在**完整**的那一栏。这里没有「使用者瞄准的两张卡」可以依据,
   *    「最后」讲的就是这一栏真正的最后一张。拿筛过的清单去算,「放到 Done 的
   *    最后」在有筛选时会变成「放到 Done 的中间」—— 而且要等清掉筛选才看得到;
   *    新任务与详情弹窗的 "Move to" 走的 bottomPosition() 吃的是整份 tasks,
   *    两边对栏尾的说法也会当场对不起来。
   */
  function requestMove(taskId: string, status: TaskStatus, beforeId: string | null) {
    const task = tasks.find(t => t.id === taskId)
    if (!task) return
    if (!canManage && task.assigned_to !== currentStaffId) return
    if (beforeId === taskId) return   // 丢在自己身上 —— 没动

    const column = beforeId === null ? sortedIn(allTasks, status) : byCol[status]
    const rest   = column.filter(t => t.id !== taskId)
    const found  = beforeId === null ? -1 : rest.findIndex(t => t.id === beforeId)
    const at     = found === -1 ? rest.length : found

    // 落回原位就什么都不做。同一个插入点有两条路指得到(这张的下半 = 下一张的
    // 上半),不挡的话很容易送出一笔什么都没改的写入,而那笔写入还会让已经在
    // Done 的卡再被问一次「还有子项没做完」。比对的是同一份清单里的位置:
    // 栏尾那条路比的是完整清单,所以「看得到的最后一张、但底下还压着别人的卡」
    // 会被正确地当成一次真的搬动。
    if (task.status === status && at === column.findIndex(t => t.id === taskId)) return

    onMove(taskId, status, insertPosition(rest, at))
  }

  function handleDrop(status: TaskStatus, beforeId: string | null) {
    const id = draggingId
    setDraggingId(null)
    setDropAt(null)
    if (id) requestMove(id, status, beforeId)
  }

  function clearDragState() {
    setDraggingId(null)
    setDropAt(null)
  }

  return (
    <>
      {/* Mobile column tabs */}
      <div className="flex sm:hidden gap-1 mb-4 bg-[#EDE5D8] rounded-xl p-1">
        {TASK_COLUMNS.map(col => (
          <button
            key={col.key}
            onClick={() => setMobileTab(col.key)}
            className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
              mobileTab === col.key
                ? 'bg-white text-[#3D2B1F] shadow-sm'
                : 'text-[#8B7355]'
            }`}
          >
            {col.label}{' '}
            <span className="opacity-60">({byCol[col.key].length})</span>
          </button>
        ))}
      </div>

      {/* Desktop: 3-column Kanban */}
      <div className="hidden sm:grid grid-cols-3 gap-4">
        {TASK_COLUMNS.map(col => (
          <KanbanColumn
            key={col.key}
            variant="desktop"
            colKey={col.key}
            label={col.label}
            tasks={byCol[col.key]}
            canManage={canManage}
            currentStaffId={currentStaffId}
            dropAt={dropAt?.col === col.key ? dropAt : null}
            onDragOver={e => { e.preventDefault(); setDropAt({ col: col.key, beforeId: null }) }}
            // 只有真的离开整栏才熄灯。dragleave 会从每一张卡上冒泡上来,不看
            // relatedTarget 的话,指标从卡片移到隔壁卡片就足以让指示线闪一下。
            onDragLeave={e => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt(null)
            }}
            onDrop={e => { e.preventDefault(); handleDrop(col.key, null) }}
            onZoneOver={beforeId => setDropAt({ col: col.key, beforeId })}
            onZoneDrop={beforeId => handleDrop(col.key, beforeId)}
            draggingId={draggingId}
            onDragStart={id => setDraggingId(id)}
            onDragEnd={clearDragState}
            onCardClick={onCardClick}
            onAddClick={onAddClick}
          />
        ))}
      </div>

      {/* Mobile: single active column */}
      <div className="sm:hidden">
        <KanbanColumn
          variant="mobile"
          colKey={mobileTab}
          label={TASK_COLUMNS.find(c => c.key === mobileTab)!.label}
          tasks={byCol[mobileTab]}
          canManage={canManage}
          currentStaffId={currentStaffId}
          dropAt={null}
          onDragOver={() => {}}
          onDragLeave={() => {}}
          onDrop={() => {}}
          onZoneOver={() => {}}
          onZoneDrop={() => {}}
          draggingId={null}
          onDragStart={() => {}}
          onDragEnd={() => {}}
          onCardClick={onCardClick}
          onAddClick={onAddClick}
          showMobileActions
          onCardStatusChange={(taskId, status) => requestMove(taskId, status, null)}
        />
      </div>
    </>
  )
}
