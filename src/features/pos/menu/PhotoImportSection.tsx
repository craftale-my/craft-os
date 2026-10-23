// src/features/pos/menu/PhotoImportSection.tsx
import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchPhotoTargets, type PhotoTarget } from './slotsApi'
import { planPhotoImport, readPhotoZip, withoutPhoto, type PhotoMatch, type PhotoPlan } from './photoImport'
import { uploadProductPhoto } from './photoUpload'
import { OutcomeLine, btnCls, errorText, linkBtnCls, useUnsavedWarning } from './editorUi'

type Stage =
  | { kind: 'pick' }
  | { kind: 'reading' }
  | { kind: 'preview'; fileName: string; plan: PhotoPlan; skipped: string[] }
  | { kind: 'uploading'; done: number; total: number }
  | { kind: 'done'; uploaded: number; failed: string[]; warnings: string[]; plan: PhotoPlan; missing: PhotoTarget[] | null; reloadError: string | null }

/** A short list with "and N more". */
function Names({ title, names }: { title: string; names: string[] }) {
  if (names.length === 0) return null
  return (
    <details className="text-sm">
      <summary>{title} ({names.length})</summary>
      <p className="mt-1 text-brown-muted">{names.slice(0, 200).join(', ')}{names.length > 200 ? `, and ${names.length - 200} more` : ''}</p>
    </details>
  )
}

/** /menu/import → Photos (spec §5): a zip of <feedme_product_id>.<ext> files; each file is
 *  matched by Feedme product ID, resized and uploaded, one at a time. Lists files that match
 *  no product and products still without a photo. */
export default function PhotoImportSection() {
  const [stage, setStage] = useState<Stage>({ kind: 'pick' })
  const [error, setError] = useState<string | null>(null)
  const [skipExisting, setSkipExisting] = useState(true)
  const busyRef = useRef(false)
  const stopRef = useRef(false)
  useUnsavedWarning(stage.kind === 'uploading')                // leaving mid-upload stops it: ask first

  const onFile = async (file: File | undefined) => {
    if (!file || busyRef.current) return
    setError(null)
    setStage({ kind: 'reading' })
    try {
      let read
      try {
        read = readPhotoZip(new Uint8Array(await file.arrayBuffer()))
      } catch {
        throw new Error('That file is not a zip of photos.')
      }
      const targets = await fetchPhotoTargets()
      setStage({ kind: 'preview', fileName: file.name, plan: planPhotoImport(read.photos, targets, skipExisting), skipped: read.skipped })
    } catch (e) {
      setError(errorText(e))
      setStage({ kind: 'pick' })
    }
  }

  const upload = async (plan: PhotoPlan) => {
    if (busyRef.current) return
    busyRef.current = true
    stopRef.current = false
    const failed: string[] = []
    const warnings: string[] = []
    let uploaded = 0
    const todo: PhotoMatch[] = plan.toUpload
    setStage({ kind: 'uploading', done: 0, total: todo.length })
    for (const [i, { photo, product }] of todo.entries()) {
      if (stopRef.current) { failed.push(`Stopped before ${photo.fileName} and ${todo.length - i - 1} more`); break }
      try {
        const res = await uploadProductPhoto(product.id, new Blob([photo.bytes.slice()], { type: photo.type }))
        uploaded++
        if (res.warning) warnings.push(`${product.name}: ${res.warning}`)
      } catch (e) {
        failed.push(`${photo.fileName} (${product.name}): ${errorText(e)}`)
      }
      setStage({ kind: 'uploading', done: i + 1, total: todo.length })
    }
    let missing: PhotoTarget[] | null = null
    let reloadError: string | null = null
    try {
      missing = withoutPhoto(await fetchPhotoTargets())
    } catch (e) {
      reloadError = `Could not list the products still without a photo: ${errorText(e)}`
    }
    setStage({ kind: 'done', uploaded, failed, warnings, plan, missing, reloadError })
    busyRef.current = false
  }

  return (
    <section className="space-y-3 rounded border border-border p-4">
      <h2 className="text-lg font-semibold">Photos from Feedme</h2>
      <p className="text-sm text-gray-500">
        Choose a zip of product photos named by Feedme product ID (e.g. <code>6512ab….jpg</code>). Each photo is matched to the
        product imported with that ID, resized to 800 px wide and uploaded. Photos can also be added one by one in a product’s editor.
      </p>
      {error && <OutcomeLine outcome={{ kind: 'error', text: error }} />}

      {stage.kind === 'pick' && (
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <input type="file" accept=".zip" aria-label="Zip of product photos" onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = '' }} />
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={skipExisting} onChange={(e) => setSkipExisting(e.target.checked)} />
            Skip products that already have a photo
          </label>
        </div>
      )}
      {stage.kind === 'reading' && <p className="text-sm">Reading the zip…</p>}

      {stage.kind === 'preview' && (
        <div className="space-y-2 text-sm">
          <p>
            <b>{stage.fileName}</b>: {stage.plan.toUpload.length} photo{stage.plan.toUpload.length === 1 ? '' : 's'} to upload
            {stage.plan.keptExisting.length > 0 && `, ${stage.plan.keptExisting.length} skipped (the product already has a photo)`}
            {stage.plan.unmatched.length > 0 && `, ${stage.plan.unmatched.length} match no product`}.
          </p>
          <Names title="Files that match no product" names={stage.plan.unmatched} />
          <Names title="Second photos for the same product (not used)" names={stage.plan.duplicates} />
          <Names title="Files that are not images" names={stage.skipped} />
          <Names title="Skipped: the product already has a photo" names={stage.plan.keptExisting.map((m) => m.product.name)} />
          <div className="flex gap-2">
            <button className={btnCls} disabled={stage.plan.toUpload.length === 0} onClick={() => void upload(stage.plan)}>
              Upload {stage.plan.toUpload.length} photo{stage.plan.toUpload.length === 1 ? '' : 's'}
            </button>
            <button className={linkBtnCls} onClick={() => setStage({ kind: 'pick' })}>Choose another zip</button>
          </div>
        </div>
      )}

      {stage.kind === 'uploading' && (
        <div className="flex items-center gap-3 text-sm">
          <span role="status">Uploaded {stage.done} of {stage.total}…</span>
          <button className={linkBtnCls} onClick={() => { stopRef.current = true }}>Stop</button>
        </div>
      )}

      {stage.kind === 'done' && (
        <div className="space-y-2 text-sm">
          <OutcomeLine outcome={stage.failed.length === 0
            ? { kind: 'ok', text: `Uploaded ${stage.uploaded} photo${stage.uploaded === 1 ? '' : 's'}.` }
            : { kind: 'error', text: `Uploaded ${stage.uploaded}; ${stage.failed.length} not uploaded — see below.` }} />
          <Names title="Not uploaded" names={stage.failed} />
          <Names title="Saved, with a warning" names={stage.warnings} />
          <Names title="Files that matched no product" names={stage.plan.unmatched} />
          {stage.reloadError && <OutcomeLine outcome={{ kind: 'error', text: stage.reloadError }} />}
          {stage.missing && (stage.missing.length === 0
            ? <p>Every product on sale has a photo.</p>
            : <Names title="Products on sale still without a photo" names={stage.missing.map((t) => t.name)} />)}
          <p className="text-brown-muted">Add the missing ones in each product’s editor (<Link to="/menu" className="underline">Products</Link>).</p>
          <button className={linkBtnCls} onClick={() => setStage({ kind: 'pick' })}>Import another zip</button>
        </div>
      )}
    </section>
  )
}
