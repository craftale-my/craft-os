import { useState, useEffect, useRef, useCallback } from 'react'
import { File as FileIcon, X } from 'lucide-react'
import { fetchAttachments, uploadAttachment, deleteAttachment } from './api'
import type { Attachment } from './types'

/** accept="image/*" 只挡得住使用者自己选档的那一次;这张表随时可能被别的入口
 *  塞进一笔非图片的列(例如日后开放 PDF、或旧资料汇入),缩图格必须认得出来,
 *  不然 <img src=...> 会画出一个破图示,而不是「这其实是个档案」。 */
function isImage(att: Attachment): boolean {
  return (att.mime_type ?? '').startsWith('image/')
}

/**
 * 一个任务底下的附件缩图墙。
 *
 * 跟 ChecklistEditor 同一套形状:自己管自己的 fetch / loading / error,
 * `onChanged()` 只在附件笔数真的变了(上传成功、删除成功)才呼叫 ——
 * 板上卡片的回形针数字靠它重拉。
 *
 * 删除固定先清 DB 列、列真的删掉才清 storage 物件(deleteAttachment 里的顺序),
 * 这里不重复那个判断,只管把结果显示出来。
 */
export function AttachmentGallery({ taskId, currentStaffId, canEdit, onChanged }: {
  taskId: string
  currentStaffId: string
  canEdit: boolean
  /** 附件笔数变了 —— 请页面层重拉板,卡片上的回形针数字靠它。 */
  onChanged: () => void
}) {
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [loading, setLoading]         = useState(true)
  const [uploading, setUploading]     = useState(false)
  const [error, setError]             = useState('')
  const [lightboxId, setLightboxId]   = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    try {
      setAttachments(await fetchAttachments(taskId))
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load attachments.')
    } finally {
      setLoading(false)
    }
  }, [taskId])

  useEffect(() => { load() }, [load])

  // Esc 关灯箱。overlay 本身点哪里都会关(见下面 onClick),这里只补键盘那一半 ——
  // 不做 focus trap,使用者随时能 Tab 出去,这不是一个要挡住操作的对话框。
  useEffect(() => {
    if (lightboxId === null) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setLightboxId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lightboxId])

  async function handleFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    if (fileRef.current) fileRef.current.value = ''
    if (files.length === 0) return

    setUploading(true)
    // 逐一 await,不用 Promise.all —— storage path 用 Date.now() 命名,并行送出
    // 同一毫秒内可能撞出同一个档名,后一个会覆盖前一个刚传完的档案。
    const failures: { name: string; reason: string }[] = []
    let anyOk = false
    for (const file of files) {
      const res = await uploadAttachment(taskId, file, currentStaffId)
      if (res.ok) anyOk = true
      else failures.push({ name: file.name, reason: res.reason })
    }
    setUploading(false)

    // 先重拉、再决定错误讯息怎么写 —— load() 一读成功就会把 error 清成 ''
    // (跟 ChecklistEditor.load() 同一套),顺序反过来的话,刚设好的「部分失败」
    // 讯息会被这次重拉自己冲掉,使用者只会看到清单多了一张、却不知道另一张失败了。
    if (anyOk) await load()

    if (failures.length === 0) {
      setError('')
    } else if (files.length === 1) {
      setError(`Could not upload the image — ${failures[0].reason}`)
    } else {
      // 选了好几张,其中几张失败:讲清楚是哪几张,成功的那些不该被这句话盖过去。
      setError(
        `${failures.length} of ${files.length} image(s) could not be uploaded — `
        + failures.map(f => `${f.name} (${f.reason})`).join('; '),
      )
    }

    // 只要有一张传成功,附件笔数就变了,不管其它几张有没有失败。
    if (anyOk) onChanged()
  }

  async function handleDelete(att: Attachment) {
    if (!window.confirm('Delete this image? This cannot be undone.')) return
    const res = await deleteAttachment(att)
    if (!res.ok) { setError(`Could not remove the image — ${res.reason}`); return }
    setError('')
    await load()
    onChanged()
  }

  const lightboxAtt = attachments.find(a => a.id === lightboxId) ?? null

  return (
    <div data-testid="attachment-gallery">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-semibold text-[#8B7355]">Attachments</p>
        {attachments.length > 0 && (
          <span className="text-xs font-semibold text-[#8B7355]" data-testid="attachment-count">
            {attachments.length}
          </span>
        )}
      </div>

      {error && (
        <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2 mb-2">{error}</p>
      )}

      {loading ? (
        <p className="text-xs text-[#A09080]">Loading attachments...</p>
      ) : (
        <div className="flex flex-wrap gap-3">
          {attachments.map(att => (
            <div key={att.id} className="relative w-24 h-24 flex-shrink-0" data-testid={`attachment-${att.id}`}>
              {isImage(att) ? (
                <img
                  src={att.url}
                  alt={att.file_name ?? 'Task attachment'}
                  onClick={() => setLightboxId(att.id)}
                  className="w-24 h-24 object-cover rounded-lg border border-[#EDE5D8] shadow-sm cursor-pointer"
                />
              ) : (
                <div className="w-24 h-24 flex flex-col items-center justify-center gap-1 rounded-lg border border-[#EDE5D8] bg-[#F5EDE0] text-[#8B7355] px-1.5">
                  <FileIcon size={20} />
                  <span className="text-[10px] text-center leading-tight line-clamp-2 break-all">
                    {att.file_name ?? 'File'}
                  </span>
                </div>
              )}
              {canEdit && (
                <button
                  type="button"
                  onClick={() => handleDelete(att)}
                  aria-label={`Remove ${att.file_name ?? 'attachment'}`}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-white border border-[#D4C5B0] text-[#9E4A30] flex items-center justify-center shadow-sm hover:bg-[#FCF0EC] transition-colors"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          ))}

          {canEdit && (
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="w-24 h-24 flex-shrink-0 flex items-center justify-center rounded-lg border-2 border-dashed border-[#D4C5B0] text-xs text-[#8B7355] hover:border-[#C4813A] hover:text-[#3D2B1F] transition-colors disabled:opacity-60 text-center px-1"
            >
              {uploading ? 'Uploading...' : '+ Add Image'}
            </button>
          )}

          {attachments.length === 0 && !canEdit && (
            <p className="text-xs text-[#A09080]">No attachments</p>
          )}
        </div>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={handleFiles}
      />

      {/* Lightbox —— 点缩图开单张大图,点 overlay 任何地方(包含图片本身)或按 Esc 都关掉。 */}
      {lightboxAtt && isImage(lightboxAtt) && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4"
          onClick={() => setLightboxId(null)}
        >
          <img
            src={lightboxAtt.url}
            alt={lightboxAtt.file_name ?? 'Task attachment full size'}
            className="max-w-full max-h-full rounded-lg"
          />
        </div>
      )}
    </div>
  )
}
