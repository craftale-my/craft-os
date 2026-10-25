// src/features/pos/menu/ProductEditorPage.tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { fetchLookups, fetchProductDetail, saveProduct, type MenuLookups } from './menuEditorApi'
import {
  emptyProductForm, productFormDirty, productFormFromDetail, productPayload, productProblems, type ProductForm, type ProductSection,
} from './productForm'
import DetailsSection from './product/DetailsSection'
import VariantsSection from './product/VariantsSection'
import GroupsSection from './product/GroupsSection'
import CatalogsSection from './product/CatalogsSection'
import PhotoSection from './product/PhotoSection'
import TimeSlotsSection from './product/TimeSlotsSection'
import { OutcomeLine, PageHeader, btnCls, errorText, useSavedNotice, useUnsavedWarning, type Outcome } from './editorUi'

/** /menu/products/new and /menu/products/:id. Everything is saved at once by
 *  menu_save_product (one transaction); a problem shows in its own section, the
 *  outcome next to Save. The route remounts this page per product (MenuRoutes keys it). */
export default function ProductEditorPage({ productId }: { productId: string | null }) {
  const navigate = useNavigate()
  const savedNotice = useSavedNotice()
  const [lookups, setLookups] = useState<MenuLookups | null>(null)
  const [form, setForm] = useState<ProductForm | null>(null)
  const [loaded, setLoaded] = useState<ProductForm | null>(null)    // the form as loaded: a save sends only changes
  const [feedmeId, setFeedmeId] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [tried, setTried] = useState(false)                          // problems show after the first Save
  const [outcome, setOutcome] = useState<Outcome | null>(savedNotice ? { kind: 'ok', text: savedNotice } : null)
  const loadSeq = useRef(0)

  /** Loads lookups and the product; a reply to an older load is dropped. */
  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    const [l, d] = await Promise.all([fetchLookups(), productId ? fetchProductDetail(productId) : Promise.resolve(null)])
    if (seq !== loadSeq.current) return
    const ids = l.catalogs.map((c) => c.id)
    setLookups(l)
    setFeedmeId(d?.feedmeProductId ?? null)
    const f = d ? productFormFromDetail(d, ids) : emptyProductForm(ids)
    setForm(f)
    setLoaded(d ? f : null)
    setLoadError(null)
  }, [productId])
  useEffect(() => { load().catch((e) => setLoadError(errorText(e))) }, [load])

  /** Reload after a failure; a "Saved, but reloading failed" notice becomes plain "Saved". */
  const retryLoad = () => {
    load()
      .then(() => setOutcome((o) => (o?.kind === 'error' && o.text.startsWith('Saved, but') ? { kind: 'ok', text: 'Saved' } : o)))
      .catch((e) => setLoadError(errorText(e)))
  }

  const change = (next: ProductForm) => { setForm(next); setOutcome(null) }
  const catalogName = (id: string) => lookups?.catalogs.find((c) => c.id === id)?.name ?? 'A catalog'
  const problems = form ? productProblems(form, catalogName) : []
  useUnsavedWarning(!!form && !saving && productFormDirty(form, loaded) && (loaded !== null || form.name.trim() !== ''))
  const problemOf = (section: ProductSection) => (tried ? problems.find((p) => p.section === section)?.message ?? null : null)

  const save = async () => {
    if (!form || saving || loadError) return
    setTried(true)
    if (problems.length > 0) { setOutcome({ kind: 'error', text: 'Not saved — fix the problems marked above.' }); return }
    setSaving(true)
    setOutcome(null)
    try {
      const id = await saveProduct(productPayload(form, loaded))
      if (!form.id) {
        navigate(`/menu/products/${id}`, { replace: true, state: { saved: 'Product created' } })
        return
      }
      try {
        await load()
        setTried(false)
        setOutcome({ kind: 'ok', text: 'Saved' })
      } catch (e) {
        // The form on screen is now stale: lock it until a fresh load succeeds.
        setLoadError(errorText(e))
        setOutcome({ kind: 'error', text: 'Saved, but reloading failed — reload before editing again.' })
      }
    } catch (e) {
      setOutcome({ kind: 'error', text: errorText(e) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <PageHeader title={productId ? form?.name || 'Product' : 'New product'}>
        <Link to="/menu" className="text-sm underline">Back to products</Link>
      </PageHeader>
      {feedmeId && (
        <p className="text-xs text-brown-muted">
          Imported from Feedme. Craft OS is the master of the menu: importing again overwrites what you change here.
        </p>
      )}
      {loadError && (
        <div className="flex items-center gap-3">
          <OutcomeLine outcome={{ kind: 'error', text: loadError }} />
          <button className="text-sm underline" disabled={saving} onClick={() => retryLoad()}>Try again</button>
        </div>
      )}
      {!form || !lookups ? (!loadError && <p className="text-sm">Loading…</p>) : (
        <>
          {/* Sections top to bottom. Photo and Time slots (M3) save on their own, so they sit
              outside the fieldset and appear once the product exists. */}
          {/* Locked while saving (the reload would overwrite typing) and while the form is stale after a failed reload. */}
          <fieldset disabled={saving || !!loadError} className="m-0 min-w-0 space-y-4 border-0 p-0">
            <DetailsSection form={form} onChange={change} categories={lookups.categories} problem={problemOf('details')} />
          </fieldset>
          {form.id
            ? <PhotoSection productId={form.id} productName={form.name} />
            : <p className="text-sm text-brown-muted">Create the product first, then add its photo and time slots.</p>}
          <fieldset disabled={saving || !!loadError} className="m-0 min-w-0 space-y-4 border-0 p-0">
            <VariantsSection form={form} onChange={change} problem={problemOf('variants')} />
            <GroupsSection form={form} onChange={change} groups={lookups.groups} problem={problemOf('groups')} />
          </fieldset>
          {form.id && <TimeSlotsSection productId={form.id} />}
          <fieldset disabled={saving || !!loadError} className="m-0 min-w-0 space-y-4 border-0 p-0">
            <CatalogsSection form={form} onChange={change} catalogs={lookups.catalogs} problem={problemOf('catalogs')} />
          </fieldset>
          <div className="sticky bottom-0 flex flex-wrap items-center gap-3 border-t border-border bg-cream py-3">
            <button className={btnCls} disabled={saving || !!loadError} onClick={() => void save()}>
              {saving ? 'Saving…' : form.id ? 'Save product' : 'Create product'}
            </button>
            <OutcomeLine outcome={outcome} />
          </div>
        </>
      )}
    </div>
  )
}
