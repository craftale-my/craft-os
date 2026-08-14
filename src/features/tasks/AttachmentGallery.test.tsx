// @vitest-environment jsdom
//
// AttachmentGallery 的重点是两条使用者看得到、但只在这里才测得到的规则:
//
//  1. 删除是破坏性且不可逆的操作 —— 跟删任务、删标签、删子项同一条 window.confirm
//     规格:取消什么都不该发生,confirm 才会真的呼叫 deleteAttachment。
//     真正「档案有没有跟着从 bucket 清掉」是 api.attachments.test.ts 的事:
//     这里整包 mock 掉 ./api,只证明得了「组件有没有把呼叫发出去」。
//  2. 上传是 accept="image/*" 挡不住的自由输入,失败要让使用者看得到、
//     而且多选时一张失败不能连带盖过其它张已经成功的结果。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import type { Attachment } from './types'

const h = vi.hoisted(() => ({
  fetchAttachments: vi.fn(),
  uploadAttachment:  vi.fn(),
  deleteAttachment:  vi.fn(),
}))

vi.mock('./api', () => ({
  fetchAttachments: h.fetchAttachments,
  uploadAttachment:  h.uploadAttachment,
  deleteAttachment:  h.deleteAttachment,
}))

const { AttachmentGallery } = await import('./AttachmentGallery')

const PHOTO: Attachment = {
  id: 'att-1',
  task_id: 'task-1',
  url: 'https://cdn.test/task-1/beans.jpg',
  storage_path: 'task-1/beans.jpg',
  file_name: 'beans.jpg',
  mime_type: 'image/jpeg',
  size_bytes: 2048,
  uploaded_by: 'staff-1',
  created_at: '2026-08-14T00:00:00Z',
}

const OK      = { ok: true } as const
const BLOCKED = { ok: false, reason: 'it was not saved — you may have been signed out.' } as const

beforeEach(() => {
  vi.resetAllMocks()
  h.fetchAttachments.mockResolvedValue([{ ...PHOTO }])
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()   // window.confirm 是 spy 上去的,不还原会留给下一个测试档
})

function fileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="file"]')
  if (!input) throw new Error('file input not found')
  return input as HTMLInputElement
}

function selectFiles(input: HTMLInputElement, files: File[]) {
  fireEvent.change(input, { target: { files } })
}

describe('缩图墙', () => {
  it('renders a thumbnail per attachment', async () => {
    render(<AttachmentGallery taskId="task-1" currentStaffId="staff-1" canEdit onChanged={vi.fn()} />)

    expect(await screen.findByTestId('attachment-att-1')).toBeTruthy()
    expect(screen.getByAltText('beans.jpg')).toBeTruthy()
  })

  it('falls back to a file icon instead of a broken <img> for a non-image row', async () => {
    h.fetchAttachments.mockResolvedValue([{ ...PHOTO, mime_type: 'application/pdf', file_name: 'menu.pdf' }])
    render(<AttachmentGallery taskId="task-1" currentStaffId="staff-1" canEdit onChanged={vi.fn()} />)

    await screen.findByTestId('attachment-att-1')
    // 不该有 <img>——一个非图片的 mime_type 硬套 <img src> 只会画出浏览器的破图示。
    expect(screen.queryByAltText('menu.pdf')).toBeNull()
    expect(screen.getByText('menu.pdf')).toBeTruthy()
  })
})

describe('删除一张图', () => {
  function removeButton() {
    return screen.findByLabelText('Remove beans.jpg')
  }

  it('asks first, and does nothing at all when the confirmation is cancelled', async () => {
    const confirmed = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const onChanged = vi.fn()
    render(<AttachmentGallery taskId="task-1" currentStaffId="staff-1" canEdit onChanged={onChanged} />)

    fireEvent.click(await removeButton())

    await waitFor(() => expect(confirmed).toHaveBeenCalledTimes(1))
    expect(h.deleteAttachment).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
    expect(screen.queryByText(/Could not remove the image/i)).toBeNull()
    expect(screen.getByTestId('attachment-att-1')).toBeTruthy()
  })

  it('deletes, reloads the gallery and tells the board once confirmed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    h.deleteAttachment.mockResolvedValue(OK)
    const onChanged = vi.fn()
    render(<AttachmentGallery taskId="task-1" currentStaffId="staff-1" canEdit onChanged={onChanged} />)
    await screen.findByTestId('attachment-att-1')
    h.fetchAttachments.mockResolvedValue([])   // 删完之后重拉,这次是空的

    fireEvent.click(await removeButton())

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    expect(h.deleteAttachment.mock.calls[0][0]).toMatchObject({ id: 'att-1', storage_path: 'task-1/beans.jpg' })
    expect(h.fetchAttachments).toHaveBeenCalledTimes(2)   // 首载 + 删除后重拉
    await waitFor(() => expect(screen.queryByTestId('attachment-att-1')).toBeNull())
  })

  it('shows the reason and keeps the thumbnail when the delete is silently rejected', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    h.deleteAttachment.mockResolvedValue(BLOCKED)
    const onChanged = vi.fn()
    render(<AttachmentGallery taskId="task-1" currentStaffId="staff-1" canEdit onChanged={onChanged} />)

    fireEvent.click(await removeButton())

    expect(await screen.findByText(/Could not remove the image/i)).toBeTruthy()
    expect(onChanged).not.toHaveBeenCalled()
    expect(screen.getByTestId('attachment-att-1')).toBeTruthy()
  })
})

describe('上传失败', () => {
  it('reports the reason and does not tell the board anything changed', async () => {
    h.uploadAttachment.mockResolvedValue({ ok: false, reason: 'the file is too large' })
    const onChanged = vi.fn()
    const { container } = render(
      <AttachmentGallery taskId="task-1" currentStaffId="staff-1" canEdit onChanged={onChanged} />,
    )
    await screen.findByTestId('attachment-att-1')

    const file = new File(['x'], 'huge.jpg', { type: 'image/jpeg' })
    selectFiles(fileInput(container), [file])

    expect(await screen.findByText(/Could not upload the image — the file is too large/i)).toBeTruthy()
    expect(onChanged).not.toHaveBeenCalled()
    // 没有一张传成功,附件笔数没变,不该重拉整块板。
    expect(h.fetchAttachments).toHaveBeenCalledTimes(1)
  })

  it('names the failed file without hiding that the others went through, for a partial multi-select failure', async () => {
    h.uploadAttachment.mockImplementation(async (_taskId: string, file: File) =>
      file.name === 'bad.jpg' ? { ok: false, reason: 'unsupported file type' } : { ok: true },
    )
    const onChanged = vi.fn()
    const { container } = render(
      <AttachmentGallery taskId="task-1" currentStaffId="staff-1" canEdit onChanged={onChanged} />,
    )
    await screen.findByTestId('attachment-att-1')
    h.fetchAttachments.mockResolvedValue([{ ...PHOTO }, { ...PHOTO, id: 'att-2', file_name: 'good.jpg' }])

    const good = new File(['x'], 'good.jpg', { type: 'image/jpeg' })
    const bad  = new File(['x'], 'bad.jpg',  { type: 'image/jpeg' })
    selectFiles(fileInput(container), [good, bad])

    expect(await screen.findByText(/1 of 2 image\(s\) could not be uploaded — bad\.jpg \(unsupported file type\)/i)).toBeTruthy()
    // 一张成功了,附件笔数变了,板还是要重拉。
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
  })
})
