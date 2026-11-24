import { useEffect, useState } from 'react'
import { fetchBranchCatalogs, saveBranchCatalogs } from './posApi'
import {
  activeCatalogs, additionalChoices, catalogSettingsFrom, catalogSettingsProblem, settingsToSave, toggleAdditional,
  type BranchCatalogSettings, type CatalogRow,
} from './catalogs'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const box = 'rounded-xl border border-border bg-card p-4'
const input = 'rounded border border-border p-1'
const DEFAULTS: { key: 'dineIn' | 'takeaway' | 'qr'; label: string }[] = [
  { key: 'dineIn', label: 'Dine-in orders' },
  { key: 'takeaway', label: 'Takeaway orders' },
  { key: 'qr', label: 'QR orders (customers’ phones)' },
]

/** POS settings → Menu catalogs: which catalog prices each kind of order at this
 *  outlet, and which catalogs a cashier may switch an order to. access_settings
 *  holders, outlets in their scope (save_branch_catalogs). The outcome shows beside Save. */
export default function MenuCatalogsSection({ branchId }: { branchId: string }) {
  const [catalogs, setCatalogs] = useState<CatalogRow[]>([])
  const [form, setForm] = useState<BranchCatalogSettings | null>(null)
  const [outcome, setOutcome] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [saving, setSaving] = useState(false)

  const load = async () => {
    const { catalogs: c, assignments } = await fetchBranchCatalogs(branchId)
    setCatalogs(c)
    setForm(catalogSettingsFrom(assignments))
  }
  useEffect(() => { load().catch((e) => setOutcome({ kind: 'error', text: msg(e) })) }, [branchId]) // eslint-disable-line react-hooks/exhaustive-deps

  const change = (next: BranchCatalogSettings) => { setForm(next); setOutcome(null) }
  const save = async () => {
    if (!form) return
    setOutcome(null)
    const problem = catalogSettingsProblem(form, catalogs)
    if (problem) { setOutcome({ kind: 'error', text: problem }); return }
    setSaving(true)
    try {
      await saveBranchCatalogs(branchId, settingsToSave(form, catalogs))     // a ticked catalog switched off since is dropped
      try {
        await load()
      } catch (e) {
        setOutcome({ kind: 'error', text: `Saved, but reloading failed: ${msg(e)}` })
        return
      }
      setOutcome({ kind: 'ok', text: 'Menu catalogs saved' })
    } catch (e) {
      setOutcome({ kind: 'error', text: msg(e) })
    } finally { setSaving(false) }
  }

  const active = activeCatalogs(catalogs)
  // a saved catalog that was switched off since still shows, so the select never lies
  const optionsFor = (id: string | null) => {
    const extra = id && !active.some((c) => c.id === id) ? catalogs.filter((c) => c.id === id) : []
    return [...active, ...extra]
  }
  return (
    <section className={box}>
      <h2 className="font-semibold">Menu catalogs</h2>
      <p className="text-xs text-brown-muted">
        Which catalog prices each kind of order at this branch. A cashier can switch a whole order to one of the
        additional catalogs (for example Staff Meal, or Grab Food to key a Grab order by hand).
      </p>
      {!form ? <p className="mt-2 text-sm text-brown-muted">Loading…</p> : (
        <>
          <div className="mt-3 grid grid-cols-3 gap-3">
            {DEFAULTS.map(({ key, label }) => (
              <label key={key} className="block text-sm">{label}
                <select className={`${input} mt-1 w-full`} value={form[key] ?? ''}
                  onChange={(e) => change({ ...form, [key]: e.target.value || null })}>
                  <option value="">Choose…</option>
                  {optionsFor(form[key]).map((c) => (
                    <option key={c.id} value={c.id}>{c.name}{c.is_active ? '' : ' (inactive)'}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <div className="mt-3 text-sm">
            <div className="text-xs text-brown-muted">Additional catalogs cashiers may switch to</div>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
              {additionalChoices(form, catalogs).map((c) => (
                <label key={c.id} className={c.is_active ? '' : 'text-brown-muted'}>
                  <input type="checkbox" checked={form.additional.includes(c.id)}
                    onChange={(e) => change(toggleAdditional(form, c.id, e.target.checked))} /> {c.name}{c.is_active ? '' : ' (inactive)'}
                </label>
              ))}
            </div>
            {additionalChoices(form, catalogs).some((c) => !c.is_active) && (
              <p className="mt-1 text-xs text-brown-muted">
                An inactive catalog is not offered to cashiers; it is taken off this list when you save.
              </p>
            )}
          </div>
        </>
      )}
      {outcome && (outcome.kind === 'error'
        ? <p role="alert" className="mt-3 rounded bg-red-50 p-3 text-sm text-red-700">{outcome.text}</p>
        : <p role="status" className="mt-3 rounded bg-green-50 p-3 text-sm text-green-800">{outcome.text}</p>)}
      <button disabled={!form || saving} onClick={() => void save()}
        className="mt-3 rounded bg-brown-btn px-3 py-2 text-sm text-white disabled:opacity-40">
        {saving ? 'Saving…' : 'Save menu catalogs'}
      </button>
    </section>
  )
}
