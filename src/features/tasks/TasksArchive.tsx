import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { Avatar } from '../../shared/components/Avatar'
import { fetchArchivedTasks } from './api'
import type { Task } from './types'

/**
 * 完成日期,带年份。archive 本来就是给「超过 DONE_WINDOW_DAYS 天」的任务住的,
 * 随手一存就是好几年份的资料 —— 只写「5 Aug」看不出是哪一年,跟 ProjectDetail
 * 的 fmtProjectDate 是同一个理由。
 */
function fmtCompletedDate(d: string | null): string {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric' })
}

/** 搜寻框吃的不只标题:经理翻旧帐更常记得的是「哪个专案」或「谁做的」。 */
function matchesSearch(task: Task, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    task.title.toLowerCase().includes(q) ||
    (task.project?.name.toLowerCase().includes(q) ?? false) ||
    (task.assignee?.name.toLowerCase().includes(q) ?? false)
  )
}

/**
 * `/team/tasks/archive`:板上 Done 栏时间窗(见 types.ts 的 DONE_WINDOW_DAYS)
 * 挪出去的旧任务住的地方。不是看板,是一张简单的清单 —— 这里的任务已经结案,
 * 没有人会再把它们拖来拖去,Kanban 的三栏与拖放对这一页没有意义。
 *
 * fetchArchivedTasks() 读不到就 throw(定义见 api.ts,api.reads.test.ts 已经
 * 钉住这一条)。这一页自己的责任是接住那个 throw、显示错误横幅,而不是让
 * catch 把画面退化成 setTasks([]) —— 一个读取失败的 archive 跟一个真的空的
 * archive 长得一模一样,而后者是这一页完全合法的状态(团队还没完成过任何
 * 任务),没有别的信号能分辨两者,只能靠错误横幅本身。
 */
export default function TasksArchivePage() {
  const [tasks,     setTasks]     = useState<Task[]>([])
  const [firstLoad, setFirstLoad] = useState(true)
  const [error,     setError]     = useState('')
  const [search,    setSearch]    = useState('')

  const load = useCallback(async () => {
    try {
      setTasks(await fetchArchivedTasks())
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the archive.')
    } finally {
      setFirstLoad(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const shown = tasks.filter(t => matchesSearch(t, search))

  // 全屏 loader 只挡第一次进页,跟模块里其余的清单页同一个规格。
  if (firstLoad) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F5F0E8]">
        <p className="text-[#8B7355] animate-pulse">Loading archive...</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#F5F0E8]">
      <div className="max-w-5xl mx-auto px-4 py-6 lg:px-8">

        <Link
          to="/team/tasks"
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#8B7355] hover:text-[#3D2B1F] transition-colors mb-4"
        >
          <ArrowLeft size={14} />
          Board
        </Link>

        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-[#3D2B1F]">Task Archive</h1>
            <p className="text-sm text-[#A09080] mt-0.5">
              {tasks.length} completed · {shown.length} shown
            </p>
          </div>
        </div>

        {error && (
          <div
            data-testid="archive-error"
            className="flex items-center justify-between gap-3 mb-4 px-4 py-3 rounded-xl bg-red-50 border border-red-200"
          >
            <p className="text-sm text-red-700">{error}</p>
            <button
              onClick={load}
              className="text-xs font-semibold text-red-700 underline flex-shrink-0"
            >
              Retry
            </button>
          </div>
        )}

        <input
          type="search"
          placeholder="Search archived tasks..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full mb-5 px-3 py-1.5 rounded-lg border border-[#D4C5B0] bg-white text-xs text-[#3D2B1F] focus:outline-none focus:ring-2 focus:ring-[#C4813A40]"
        />

        {/* 空清单让位给错误横幅,跟 Projects.tsx / Tasks.tsx 同一个规格:读取失败
            时手上一列都没有,若照常画「Nothing archived yet.」,横幅说读不到、
            下面却说这里本来就没东西,使用者会信下面那句,因为它长得像资料。 */}
        {shown.length === 0 ? (error ? null : (
          <p className="text-sm text-[#A09080] bg-white rounded-2xl border border-[#EDE5D8] px-4 py-8 text-center">
            {tasks.length === 0 ? 'Nothing archived yet.' : 'No tasks match your search.'}
          </p>
        )) : (
          <div className="bg-white rounded-2xl border border-[#EDE5D8] overflow-hidden">
            {shown.map(t => (
              <div
                key={t.id}
                data-testid="archive-row"
                className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-[#EDE5D8] last:border-b-0"
              >
                <span className="font-semibold text-[#3D2B1F] truncate flex-1 min-w-[160px]">{t.title}</span>
                {t.project ? (
                  <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-[#F5EDE0] text-[#8B6344] max-w-[140px] flex-shrink-0">
                    <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: t.project.color }} />
                    <span className="truncate">{t.project.name}</span>
                  </span>
                ) : (
                  <span className="text-xs text-[#A09080] flex-shrink-0">No project</span>
                )}
                {t.assignee ? (
                  <span className="flex items-center gap-1.5 flex-shrink-0">
                    <Avatar name={t.assignee.name} avatar={t.assignee.avatar} size="sm" />
                    <span className="text-xs text-[#8B7355]">{t.assignee.name}</span>
                  </span>
                ) : (
                  <span className="text-xs text-[#A09080] flex-shrink-0">Unassigned</span>
                )}
                <span className="text-xs text-[#8B7355] flex-shrink-0 w-24 text-right">
                  {fmtCompletedDate(t.completed_at)}
                </span>
              </div>
            ))}
          </div>
        )}

      </div>
    </div>
  )
}
