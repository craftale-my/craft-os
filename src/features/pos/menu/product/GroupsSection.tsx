// src/features/pos/menu/product/GroupsSection.tsx
import { Link } from 'react-router-dom'
import type { LookupGroup } from '../menuEditorApi'
import { MAX_GROUPS, addGroup, moveGroup, removeGroup, type ProductForm } from '../productForm'
import { Section, inputCls, linkBtnCls } from '../editorUi'

/** The add-on groups the pad and QR offer with this product, in their order. */
export default function GroupsSection({ form, onChange, groups, problem }: {
  form: ProductForm
  onChange: (f: ProductForm) => void
  groups: LookupGroup[]
  problem: string | null
}) {
  const byId = new Map(groups.map((g) => [g.id, g]))
  const unlinked = groups.filter((g) => !form.groupIds.includes(g.id))
  return (
    <Section title="Add-on groups" hint="Edit a group's options and prices on the Add-on groups page." problem={problem}>
      {form.groupIds.length === 0 && <p className="text-sm text-brown-muted">No add-on groups.</p>}
      <ul className="space-y-1 text-sm">
        {form.groupIds.map((id, i) => {
          const g = byId.get(id)
          return (
            <li key={id} className="flex items-center gap-2">
              <span className="flex-1">
                {g ? <Link to={`/menu/groups/${id}`} className="hover:underline">{g.name}</Link> : 'Unknown group'}
                {g && <span className="ml-2 text-xs text-brown-muted">choose {g.min}–{g.max}{g.isActive ? '' : ' · off'}</span>}
              </span>
              <button type="button" className={linkBtnCls} disabled={i === 0} aria-label="Move up"
                onClick={() => onChange(moveGroup(form, i, -1))}>↑</button>
              <button type="button" className={linkBtnCls} disabled={i === form.groupIds.length - 1} aria-label="Move down"
                onClick={() => onChange(moveGroup(form, i, 1))}>↓</button>
              <button type="button" className={linkBtnCls} onClick={() => onChange(removeGroup(form, id))}>Remove</button>
            </li>
          )
        })}
      </ul>
      <select className={inputCls} value="" disabled={form.groupIds.length >= MAX_GROUPS}
        onChange={(e) => e.target.value && onChange(addGroup(form, e.target.value))}>
        <option value="">Add an add-on group…</option>
        {unlinked.map((g) => <option key={g.id} value={g.id}>{g.name}{g.isActive ? '' : ' (off)'}</option>)}
      </select>
    </Section>
  )
}
