// 附件的删除/上传是「送去 Supabase 的那几笔呼叫长什么样」,不是 UI 行为,所以
// 跟 api.checklist.test.ts / api.tags.test.ts 同一个做法:让 ./api 跑真的,
// 只把 supabase client(含 storage)换成假的。AttachmentGallery.test.tsx 那边
// mock 掉整个 ./api,证明不了 deleteAttachment 是否真的把 storage 物件也清掉了
// —— 这正是这次改动要守住的行为:旧版只清 DB 栏位,档案永远留在 bucket 里。
//
//   deleteAttachment 的顺序是「先删 DB 列,列真的没了才删 storage 物件」,
//   刻意的:半路断线留下孤儿档案(浪费空间,可回收)好过留下一列指着 404 的
//   图片网址(画面上看得到、点不开)。RLS 挡掉删除时回 { data: [], error: null }
//   —— 没有 error,若只看 error 就会连 DB 列都没删掉却去清掉了还在用的档案。
//
//   uploadAttachment 分两步:先传档案,写 DB 列失败就把刚传的档案清掉,不留孤儿。
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Attachment } from './types'

const h = vi.hoisted(() => {
  interface AttRow {
    id: string
    task_id: string
    url: string
    storage_path: string
    file_name: string | null
    mime_type: string | null
    size_bytes: number | null
    uploaded_by: string | null
  }

  const rows: AttRow[] = []
  let seq = 0

  const uploadCalls: { path: string; contentType?: string }[] = []
  const removeCalls: string[][] = []
  const insertCalls: Record<string, unknown>[] = []
  const deleteCalls: string[] = []

  let uploadFails: string | null = null
  /** null = 正常;'error' = 回 Postgres error;'rls' = RLS 挡掉(无 error、无列)。 */
  let insertFails: 'error' | 'rls' | null = null
  let deleteFails: 'error' | 'rls' | null = null
  let removeFails: string | null = null

  const storage = {
    from(bucket: string) {
      if (bucket !== 'task-attachments') throw new Error(`unexpected bucket in this test: ${bucket}`)
      return {
        async upload(path: string, _file: unknown, opts: { contentType?: string }) {
          uploadCalls.push({ path, contentType: opts?.contentType })
          if (uploadFails) return { data: null, error: { message: uploadFails } }
          return { data: { path }, error: null }
        },
        getPublicUrl(path: string) {
          return { data: { publicUrl: `https://cdn.test/task-attachments/${path}` } }
        },
        async remove(paths: string[]) {
          removeCalls.push(paths)
          if (removeFails) return { data: null, error: { message: removeFails } }
          return { data: paths.map(p => ({ name: p })), error: null }
        },
      }
    },
  }

  const supabase = {
    from(table: string) {
      if (table !== 'task_attachments') throw new Error(`unexpected table in this test: ${table}`)
      return {
        insert(values: Record<string, unknown>) {
          insertCalls.push(values)
          return {
            async select() {
              if (insertFails === 'error') {
                return { data: null, error: { message: 'permission denied for table task_attachments' } }
              }
              if (insertFails === 'rls') return { data: [], error: null }
              const row = { id: `att-${++seq}`, ...values } as AttRow
              rows.push(row)
              return { data: [{ ...row }], error: null }
            },
          }
        },
        delete() {
          return {
            eq(_col: 'id', val: string) {
              deleteCalls.push(val)
              return {
                async select() {
                  if (deleteFails === 'error') {
                    return { data: null, error: { message: 'permission denied for table task_attachments' } }
                  }
                  if (deleteFails === 'rls') return { data: [], error: null }
                  const idx = rows.findIndex(r => r.id === val)
                  if (idx === -1) return { data: [], error: null }
                  const [removed] = rows.splice(idx, 1)
                  return { data: [removed], error: null }
                },
              }
            },
          }
        },
      }
    },
    storage,
  }

  return {
    supabase, rows, uploadCalls, removeCalls, insertCalls, deleteCalls,
    failUpload(msg: string) { uploadFails = msg },
    failInsert(mode: 'error' | 'rls') { insertFails = mode },
    failDelete(mode: 'error' | 'rls') { deleteFails = mode },
    failRemove(msg: string) { removeFails = msg },
    reset() {
      rows.length = 0; seq = 0
      uploadCalls.length = 0; removeCalls.length = 0; insertCalls.length = 0; deleteCalls.length = 0
      uploadFails = null; insertFails = null; deleteFails = null; removeFails = null
    },
  }
})

vi.mock('../../shared/lib/supabase', () => ({ supabase: h.supabase }))

const { uploadAttachment, deleteAttachment } = await import('./api')

beforeEach(() => h.reset())

function seedRow(over: Partial<Attachment> = {}): Attachment {
  const row: Attachment = {
    id: 'att-1',
    task_id: 'task-1',
    url: 'https://cdn.test/task-attachments/task-1/111.jpg',
    storage_path: 'task-1/111.jpg',
    file_name: 'beans.jpg',
    mime_type: 'image/jpeg',
    size_bytes: 1024,
    uploaded_by: 'staff-1',
    created_at: '2026-08-14T00:00:00Z',
    ...over,
  }
  h.rows.push(row)
  return row
}

describe('deleteAttachment:先删 DB 列,列真的没了才清 storage 物件', () => {
  it('removes both the row and the stored object when the delete lands', async () => {
    const att = seedRow()

    const res = await deleteAttachment(att)

    expect(res.ok).toBe(true)
    expect(h.rows).toHaveLength(0)
    expect(h.removeCalls).toEqual([['task-1/111.jpg']])
  })

  it('leaves the object alone when RLS silently drops the delete — no error, no rows', async () => {
    const att = seedRow()
    h.failDelete('rls')

    const res = await deleteAttachment(att)

    expect(res.ok).toBe(false)
    // 关键的一半:列没删掉,档案就绝对不能跟着清掉,否则会留下一列指着 404 的图。
    expect(h.removeCalls).toEqual([])
    expect(h.rows).toHaveLength(1)
  })

  it('leaves the object alone when the delete itself errors', async () => {
    const att = seedRow()
    h.failDelete('error')

    const res = await deleteAttachment(att)

    expect(res.ok).toBe(false)
    expect(res.ok === false && res.reason).toMatch(/permission denied/)
    expect(h.removeCalls).toEqual([])
  })

  // 列删掉了、档案没删掉 = 一个再也没有纪录指得到的孤儿档案,跟 uploadAttachment
  // 回滚失败留下的那种一模一样。删除本身成功,不该因此对使用者报错;但也不能
  // 连这个失败都吞掉 —— 两支相邻的函式对同一件事得有同一个说法。
  it('logs the orphan when the row is gone but the stored object could not be removed', async () => {
    const att = seedRow()
    h.failRemove('Object not found')
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await deleteAttachment(att)

    expect(res.ok).toBe(true)          // 纪录真的删掉了,使用者那边就是成功
    expect(h.rows).toHaveLength(0)
    expect(logged).toHaveBeenCalledTimes(1)
    expect(String(logged.mock.calls[0][0])).toContain('task-1/111.jpg')
    expect(logged.mock.calls[0][1]).toBe('Object not found')

    logged.mockRestore()
  })
})

describe('uploadAttachment:传档案与写 DB 列,任何一步失败都不留孤儿档案', () => {
  it('inserts a row pointing at the uploaded storage path', async () => {
    const file = new File(['x'], 'beans.jpg', { type: 'image/jpeg' })

    const res = await uploadAttachment('task-1', file, 'staff-1')

    expect(res.ok).toBe(true)
    expect(h.uploadCalls).toHaveLength(1)
    expect(h.insertCalls).toHaveLength(1)
    expect(h.insertCalls[0]).toMatchObject({
      task_id: 'task-1',
      storage_path: h.uploadCalls[0].path,
      file_name: 'beans.jpg',
      mime_type: 'image/jpeg',
      uploaded_by: 'staff-1',
    })
    expect(h.removeCalls).toEqual([])   // 一切顺利,不该清掉刚传好的档案
  })

  it('fails without ever attempting the insert when the storage upload itself fails', async () => {
    h.failUpload('The object exceeded the maximum allowed size')
    const file = new File(['x'], 'huge.jpg', { type: 'image/jpeg' })

    const res = await uploadAttachment('task-1', file, 'staff-1')

    expect(res.ok).toBe(false)
    expect(res.ok === false && res.reason).toMatch(/maximum allowed size/)
    expect(h.insertCalls).toHaveLength(0)
    expect(h.removeCalls).toEqual([])   // 从没传成功,没有孤儿档案要清
  })

  it('removes the just-uploaded object when the row insert errors', async () => {
    h.failInsert('error')
    const file = new File(['x'], 'beans.jpg', { type: 'image/jpeg' })

    const res = await uploadAttachment('task-1', file, 'staff-1')

    expect(res.ok).toBe(false)
    expect(h.uploadCalls).toHaveLength(1)
    expect(h.removeCalls).toEqual([[h.uploadCalls[0].path]])
  })

  it('removes the just-uploaded object when RLS silently drops the insert', async () => {
    h.failInsert('rls')
    const file = new File(['x'], 'beans.jpg', { type: 'image/jpeg' })

    const res = await uploadAttachment('task-1', file, 'staff-1')

    expect(res.ok).toBe(false)
    expect(res.ok === false && res.reason).toMatch(/not saved/i)
    expect(h.removeCalls).toEqual([[h.uploadCalls[0].path]])
  })
})
