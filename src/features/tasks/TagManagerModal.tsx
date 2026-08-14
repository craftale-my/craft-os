import { useState } from 'react'
import { Trash2, X } from 'lucide-react'
import { normalizeTagName } from '../../shared/lib/tasks'
import { updateTag, deleteTag } from './api'
import type { Tag } from './types'

/**
 * Tag 词表的管理入口——改名、换色、删除,是唯一能修正打字错误的地方。
 * TagInput 的下拉是纯建议清单,只读不写:自由输入不设审核,`urgnet` 这类
 * 手误一旦被造出来,不会有任何机制自己修正它,只会一直躺在建议清单里,
 * 直到有人在这里把它改掉或删掉。
 *
 * `updateTag()`(api.ts)不收 `slug` 参数——想改名一定会经过
 * normalizeTagName() 重新算 slug,不存在「name 送了、slug 忘了送」这种
 * 半吊子调用;这支组件不需要、也没有办法自己拼错。
 */
export function TagManagerModal({ tags, onClose, onChanged }: {
  tags: Tag[]
  onClose: () => void
  onChanged: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-[#FDFAF6] rounded-2xl shadow-xl w-full max-w-lg max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#EDE5D8] sticky top-0 bg-[#FDFAF6]">
          <div>
            <h2 className="font-bold text-[#3D2B1F] text-lg">Manage Tags</h2>
            <p className="text-xs text-[#A09080] mt-0.5">
              Rename, recolour or delete tags used across every task.
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-[#A09080] hover:text-[#3D2B1F]"
          >
            <X size={20} />
          </button>
        </div>

        <div className="px-6 py-5">
          {tags.length === 0 ? (
            <p className="text-sm text-[#A09080] text-center py-6">No tags yet.</p>
          ) : (
            <div className="space-y-2">
              {tags.map(tag => (
                <TagRow key={tag.id} tag={tag} onChanged={onChanged} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * 一列一个 tag,自带本地编辑状态。刻意不用「id → 编辑中的值」那种集中
 * state:onChanged() 触发页面重拉 tags 之后,这个组件不会被卸载(它的 key
 * 是 tag.id,列表重排序 / 其它列被删除都不影响它的身份),但也不该被拉回来
 * 的新 props 打断使用者还没存档的输入——每一列自己管自己的草稿,天生就有
 * 这个隔离。
 */
function TagRow({ tag, onChanged }: { tag: Tag; onChanged: () => void }) {
  const [name, setName] = useState(tag.name)
  const [color, setColor] = useState(tag.color)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const dirty = name !== tag.name || color !== tag.color

  async function save() {
    const norm = normalizeTagName(name)
    if (!norm) { setError('Tag name cannot be empty.'); return }
    setSaving(true)
    setError('')
    const res = await updateTag(tag.id, { name: norm.name, color })
    setSaving(false)
    // res.reason 是没有主词的句子片段,得接在自己的句首后面。
    if (!res.ok) { setError(`Could not save — ${res.reason}`); return }
    setName(norm.name) // 落地的是正规化后的写法(去掉多余空白),本地也跟上。
    onChanged()
  }

  async function remove() {
    if (!window.confirm(`Delete "${tag.name}"? It will be removed from every task.`)) return
    setError('')
    const res = await deleteTag(tag.id)
    if (!res.ok) { setError(`Could not delete — ${res.reason}`); return }
    onChanged()
  }

  return (
    <div className="flex items-start gap-2 p-2 rounded-lg border border-[#EDE5D8]">
      <input
        type="color"
        value={color}
        onChange={e => setColor(e.target.value)}
        aria-label={`Colour for ${tag.name}`}
        className="w-9 h-9 rounded border border-[#D4C5B0] cursor-pointer flex-shrink-0"
      />
      <div className="flex-1 min-w-0">
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          aria-label={`Name for ${tag.name}`}
          className="w-full px-2.5 py-1.5 rounded-lg border border-[#D4C5B0] bg-white text-sm text-[#3D2B1F] focus:outline-none focus:ring-2 focus:ring-[#C4813A40]"
        />
        {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
      </div>
      <button
        type="button"
        onClick={save}
        disabled={!dirty || saving}
        className="px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-[#C4813A] text-white hover:bg-[#A86C2C] disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex-shrink-0"
      >
        {saving ? 'Saving...' : 'Save'}
      </button>
      <button
        type="button"
        onClick={remove}
        aria-label={`Delete ${tag.name}`}
        className="p-1.5 rounded-lg text-[#A09080] hover:text-red-600 hover:bg-red-50 transition-colors flex-shrink-0"
      >
        <Trash2 size={16} />
      </button>
    </div>
  )
}
