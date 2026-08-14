// @vitest-environment jsdom
//
// 这支弹窗是 tag 词表唯一的修正入口:自由输入不设审核,`urgnet` 这类手误只能
// 在这里改名或删掉。而它的两笔写入都撞在最容易被 RLS 挡下的那条政策上 ——
// tags_update / tags_delete 只放行 manage_projects,矩阵一关就是零列回来。
//
// 零列没有 error。少了 `if (!res.ok)`:
//  - 改名 → onChanged() 让页面重拉 tags,输入框跟着被刷回旧名字,使用者会以为
//    自己打错了,再改一次,再看它弹回去。
//  - 删除 → onChanged() 重拉,那一列原封不动地留在清单上。
// 两者都没有一个字提到「没存进去」。这支组件之前一个测试都没有。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import type { Tag } from './types'

const h = vi.hoisted(() => ({
  updateTag: vi.fn(),
  deleteTag: vi.fn(),
}))

vi.mock('./api', () => ({
  updateTag: h.updateTag,
  deleteTag: h.deleteTag,
}))

const { TagManagerModal } = await import('./TagManagerModal')

const TAG: Tag = { id: 'tag-1', slug: 'urgnet', name: 'urgnet', color: '#C4813A' }

/** RLS 静静挡掉的写入,经 writeOutcome 判定之后的样子。 */
const BLOCKED = { ok: false, reason: 'it was not saved — you may have been signed out.' } as const

function renderModal() {
  const onChanged = vi.fn()
  const onClose = vi.fn()
  render(<TagManagerModal tags={[TAG]} onClose={onClose} onChanged={onChanged} />)
  return { onChanged, onClose }
}

function nameBox() {
  return screen.getByLabelText('Name for urgnet') as HTMLInputElement
}

beforeEach(() => {
  vi.resetAllMocks()
  // remove() 走 window.confirm;jsdom 没有实作,不接管就直接炸。
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('TagManagerModal 改名 / 换色', () => {
  it('says so when the write is silently dropped, and does not ask the page to reload', async () => {
    h.updateTag.mockResolvedValue(BLOCKED)
    const { onChanged } = renderModal()

    fireEvent.change(nameBox(), { target: { value: 'urgent' } })
    fireEvent.click(screen.getByText('Save'))

    expect(await screen.findByText(/Could not save/)).toBeTruthy()
    expect(screen.getByText(/you may have been signed out/)).toBeTruthy()
    // 重拉 tags 会把输入框刷回 "urgnet",看起来就像使用者自己打错了。
    expect(onChanged).not.toHaveBeenCalled()
    expect(nameBox().value).toBe('urgent')
  })

  it('reports a name clash in the words the user can act on', async () => {
    h.updateTag.mockResolvedValue({
      ok: false,
      reason: 'a tag named "urgent" already exists — pick a different name, or delete one of them.',
    })
    const { onChanged } = renderModal()

    fireEvent.change(nameBox(), { target: { value: 'urgent' } })
    fireEvent.click(screen.getByText('Save'))

    expect(await screen.findByText(/already exists/)).toBeTruthy()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('reloads the page list only when the write really landed', async () => {
    h.updateTag.mockResolvedValue({ ok: true })
    const { onChanged } = renderModal()

    fireEvent.change(nameBox(), { target: { value: '  urgent  ' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(h.updateTag).toHaveBeenCalledWith('tag-1', { name: 'urgent', color: '#C4813A' })
    // 落地的是正规化后的写法,本地跟上,不然下一次 dirty 判断会永远是 true。
    expect(nameBox().value).toBe('urgent')
    expect(screen.queryByText(/Could not save/)).toBeNull()
  })
})

describe('TagManagerModal 删除', () => {
  it('says so when the delete is silently dropped, and does not ask the page to reload', async () => {
    h.deleteTag.mockResolvedValue(BLOCKED)
    const { onChanged } = renderModal()

    fireEvent.click(screen.getByLabelText('Delete urgnet'))

    expect(await screen.findByText(/Could not delete/)).toBeTruthy()
    expect(screen.getByText(/you may have been signed out/)).toBeTruthy()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('reloads the page list only when the delete really landed', async () => {
    h.deleteTag.mockResolvedValue({ ok: true })
    const { onChanged } = renderModal()

    fireEvent.click(screen.getByLabelText('Delete urgnet'))

    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(h.deleteTag).toHaveBeenCalledWith('tag-1')
    expect(screen.queryByText(/Could not delete/)).toBeNull()
  })

  it('writes nothing when the confirmation is declined', () => {
    vi.mocked(window.confirm).mockReturnValue(false)
    const { onChanged } = renderModal()

    fireEvent.click(screen.getByLabelText('Delete urgnet'))

    expect(h.deleteTag).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
  })
})
