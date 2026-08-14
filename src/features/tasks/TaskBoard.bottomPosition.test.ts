// @vitest-environment jsdom
//
// 「栏尾在哪」不能靠阵列的最后一格。乐观换栏只改 position、不动阵列顺序,所以
// 阵列的尾巴随时可能是号码最小的那张卡 —— bottomPosition 里那句
// `.sort((a, b) => a.position - b.position)` 就是在守这件事。
//
// 这条规则本来没有任何测试守着:把那句 sort 拿掉,整套 271 个测试仍然全绿。
// 现场会长成这样 —— 把 Done 的第二张卡拖到最上面(它拿到 0),阵列尾巴变成
// 那张现在排在最前面的卡,接着从详情弹窗按 "Move to → Done" 的任务就会算出
// 1024,跟栏里的第一张卡撞成同一个号码,而不是落到栏尾。板上会看到两张卡的
// 先后顺序由 sort 的稳定性决定,重整一次可能又换一个样子。
//
// 板层的拖放测试照不到这里:那条路走 TaskBoard 内部的 requestMove,吃的是
// 已经排过序的 byCol / sortedIn。bottomPosition 是新任务与弹窗 "Move to"
// 专用的那条路,只有直接叫它才测得到。
import { describe, it, expect } from 'vitest'
import { POSITION_STEP } from '../../shared/lib/tasks'
import { bottomPosition } from './TaskBoard'
import type { Task, TaskStatus } from './types'

function task(id: string, status: TaskStatus, position: number): Task {
  return {
    id,
    title: `Task ${id}`,
    description: null,
    status,
    priority: 'medium',
    project_id: null,
    assigned_to: 'staff-1',
    created_by: 'staff-1',
    due_date: null,
    department: null,
    position,
    completed_at: null,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    assignee: null,
    creator: null,
    project: null,
    tags: [],
    _comment_count:    0,
    _attachment_count: 0,
    _checklist_done:   0,
    _checklist_total:  0,
  }
}

describe('bottomPosition', () => {
  /**
   * 使用者刚把 y 拖到 x 之上:y 的 position 变成 0,而阵列顺序原封不动
   * —— 阵列的最后一格现在是号码最小的那一张。
   */
  it('resolves the bottom of the column by position, not by array order', () => {
    const afterDraggingYToTheTop = [task('x', 'done', 1024), task('y', 'done', 0)]

    // 栏尾讲的是号码最大的那张(x = 1024)的下面。少了 sort 会拿 y 当邻居,
    // 算出 1024 —— 跟 x 撞号,新卡不会落在栏尾。
    expect(bottomPosition(afterDraggingYToTheTop, 'done')).toBe(2048)
  })

  it('only looks at the column it was asked about', () => {
    const tasks = [task('a', 'todo', 9000), task('x', 'done', 1024)]

    expect(bottomPosition(tasks, 'done')).toBe(2048)
  })

  it('seeds an empty column', () => {
    expect(bottomPosition([task('a', 'todo', 5000)], 'done')).toBe(POSITION_STEP)
  })
})
