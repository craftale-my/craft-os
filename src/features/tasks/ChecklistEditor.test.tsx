// @vitest-environment jsdom
//
// 「谁负责哪一条」是这次改动的重点之一,而它只有一条写入路径:选单 →
// setChecklistAssignee。这里测的是那条接线本身(查询长什么样归
// api.checklist.test.ts),特别是两个很容易写错、而且错了不会有人发现的地方:
//
//  1. 放回 "Anyone" 必须送 null。<select> 的空 option 给的是 ''、不是 null,
//     直接转发的话 uuid 栏位会以 22P02 打回来,取消认领永远失败。
//  2. 写入没落地时选单要弹回原本的人。RLS 挡掉的写入没有 error 也没有列,
//     若只做乐观更新不看 WriteOutcome,画面会一直显示「已经指给某某」,
//     重新整理才发现根本没写进去。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import type { Staff } from '../../shared/types'
import type { ChecklistItem } from './types'

const h = vi.hoisted(() => ({
  fetchChecklist:       vi.fn(),
  setChecklistAssignee: vi.fn(),
  setChecklistDone:     vi.fn(),
  addChecklistItem:     vi.fn(),
  deleteChecklistItem:  vi.fn(),
}))

vi.mock('./api', () => ({
  fetchChecklist:       h.fetchChecklist,
  setChecklistAssignee: h.setChecklistAssignee,
  setChecklistDone:     h.setChecklistDone,
  addChecklistItem:     h.addChecklistItem,
  deleteChecklistItem:  h.deleteChecklistItem,
}))

const { ChecklistEditor } = await import('./ChecklistEditor')

const ITEM: ChecklistItem = {
  id: 'item-1',
  task_id: 'task-1',
  title: 'Count the bean bags',
  done: false,
  position: 1024,
  assigned_to: null,
  assignee: null,
}

const STAFF = [
  { id: 'staff-1', name: 'Yong Tan',  avatar: null },
  { id: 'staff-2', name: 'Amy Cheah', avatar: null },
] as unknown as Staff[]

const BLOCKED = { ok: false, reason: 'it was not saved — you may have been signed out.' }

beforeEach(() => {
  vi.resetAllMocks()
  h.fetchChecklist.mockResolvedValue([{ ...ITEM }])
  h.setChecklistAssignee.mockResolvedValue({ ok: true })
})
afterEach(() => {
  cleanup()
  // window.confirm 是 spy 上去的,不还原会留给下一个测试档。
  vi.restoreAllMocks()
})

async function renderEditor(onChanged = vi.fn()) {
  render(<ChecklistEditor taskId="task-1" allStaff={STAFF} onChanged={onChanged} />)
  return await screen.findByLabelText('Owner of "Count the bean bags"') as HTMLSelectElement
}

describe('子项的负责人', () => {
  it('starts as Anyone and hands the picked staff id to the write', async () => {
    const picker = await renderEditor()
    expect(picker.value).toBe('')

    fireEvent.change(picker, { target: { value: 'staff-2' } })

    await waitFor(() => expect(h.setChecklistAssignee).toHaveBeenCalledTimes(1))
    expect(h.setChecklistAssignee.mock.calls[0]).toEqual(['item-1', 'staff-2'])
  })

  it('sends null — not an empty string — when the owner is cleared', async () => {
    const picker = await renderEditor()

    fireEvent.change(picker, { target: { value: 'staff-2' } })
    await waitFor(() => expect(h.setChecklistAssignee).toHaveBeenCalledTimes(1))
    fireEvent.change(picker, { target: { value: '' } })
    await waitFor(() => expect(h.setChecklistAssignee).toHaveBeenCalledTimes(2))

    expect(h.setChecklistAssignee.mock.calls[1][1]).toBeNull()
  })

  it('puts the owner back and says why when the write is silently rejected', async () => {
    h.setChecklistAssignee.mockResolvedValue(BLOCKED)
    const picker = await renderEditor()

    fireEvent.change(picker, { target: { value: 'staff-2' } })

    expect(await screen.findByText(/Could not change the owner/i)).toBeTruthy()
    await waitFor(() => expect(picker.value).toBe(''))
  })

  it('does not refetch the whole board for an owner change — no done/total moved', async () => {
    const onChanged = vi.fn()
    const picker = await renderEditor(onChanged)

    fireEvent.change(picker, { target: { value: 'staff-2' } })

    await waitFor(() => expect(h.setChecklistAssignee).toHaveBeenCalledTimes(1))
    expect(onChanged).not.toHaveBeenCalled()
  })
})

describe('打勾', () => {
  it('asks the board to refresh so the card counter and the done gate stay honest', async () => {
    h.setChecklistDone.mockResolvedValue({ ok: true })
    const onChanged = vi.fn()
    render(<ChecklistEditor taskId="task-1" allStaff={STAFF} onChanged={onChanged} />)

    fireEvent.click(await screen.findByLabelText('Toggle "Count the bean bags"'))

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    expect(h.setChecklistDone.mock.calls[0]).toEqual(['item-1', true])
  })

  it('rolls the tick back when the write is silently rejected', async () => {
    h.setChecklistDone.mockResolvedValue(BLOCKED)
    const onChanged = vi.fn()
    render(<ChecklistEditor taskId="task-1" allStaff={STAFF} onChanged={onChanged} />)

    fireEvent.click(await screen.findByLabelText('Toggle "Count the bean bags"'))

    expect(await screen.findByText(/Could not update the item/i)).toBeTruthy()
    expect(onChanged).not.toHaveBeenCalled()
    // 0/1 —— 计数没有停在乐观更新过的 1/1。
    await waitFor(() => expect(screen.getByTestId('checklist-count').textContent).toBe('0/1'))
  })
})

describe('删掉一条子项', () => {
  // X 挨着负责人选单,一列里差几个 px,按下去连认领一起消失、没有 undo。
  // 删任务、删标签都先问一句,这条不该是全模块唯一的例外。
  function deleteButton() {
    return screen.findByLabelText('Delete "Count the bean bags"')
  }

  it('asks first, and does nothing at all when the confirmation is cancelled', async () => {
    const confirmed = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const onChanged = vi.fn()
    render(<ChecklistEditor taskId="task-1" allStaff={STAFF} onChanged={onChanged} />)

    fireEvent.click(await deleteButton())

    await waitFor(() => expect(confirmed).toHaveBeenCalledTimes(1))
    expect(h.deleteChecklistItem).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
    // 取消不是失败:不该冒出「Could not remove the item」。
    expect(screen.queryByText(/Could not remove the item/i)).toBeNull()
    expect(screen.getByTestId('checklist-item-item-1')).toBeTruthy()
  })

  it('names the item in the prompt, so it is clear which X was hit', async () => {
    const confirmed = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<ChecklistEditor taskId="task-1" allStaff={STAFF} onChanged={vi.fn()} />)

    fireEvent.click(await deleteButton())

    await waitFor(() => expect(confirmed).toHaveBeenCalledTimes(1))
    expect(confirmed.mock.calls[0][0]).toMatch(/Count the bean bags/)
  })

  it('deletes and refreshes the board once confirmed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    h.deleteChecklistItem.mockResolvedValue({ ok: true })
    const onChanged = vi.fn()
    render(<ChecklistEditor taskId="task-1" allStaff={STAFF} onChanged={onChanged} />)

    fireEvent.click(await deleteButton())

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    expect(h.deleteChecklistItem.mock.calls[0]).toEqual(['item-1'])
  })
})
