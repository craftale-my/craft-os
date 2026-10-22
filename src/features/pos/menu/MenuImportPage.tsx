import { useState } from 'react'
import { Link } from 'react-router-dom'
import { buildMenuImport, FEEDME_CATALOG, readFeedmeExport, type MenuImport } from './feedmeExport'
import { importMenu } from './menuApi'

type Stage =
  | { kind: 'pick' }
  | { kind: 'preview'; fileName: string; payload: MenuImport; warnings: string[] }
  | { kind: 'importing' }
  | { kind: 'done'; counts: Record<string, number> }

export default function MenuImportPage() {
  const [stage, setStage] = useState<Stage>({ kind: 'pick' })
  const [error, setError] = useState<string | null>(null)

  const onFile = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      let files
      try {
        files = readFeedmeExport(bytes)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        // fflate's own errors ("invalid zip data", "unexpected EOF") mean the file is not a zip at all;
        // readFeedmeExport's messages already say which workbook is missing, so pass those through
        const notAZip = /invalid zip|unexpected eof/i.test(msg)
        throw new Error(notAZip ? 'That file is not a Feedme export zip (books_….zip).' : msg)
      }
      const { payload, warnings } = buildMenuImport(files, FEEDME_CATALOG)
      setStage({ kind: 'preview', fileName: file.name, payload, warnings })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStage({ kind: 'pick' })
    }
  }

  const confirm = async (payload: MenuImport) => {
    setStage({ kind: 'importing' })
    try {
      setStage({ kind: 'done', counts: await importMenu(payload) })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStage({ kind: 'pick' })
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <Link to="/menu" className="text-sm underline">← Menu</Link>
      <h1 className="text-2xl font-semibold">Import menu from Feedme</h1>
      <p className="text-sm text-gray-500">
        In the Feedme portal go to Menu → Products → Export and choose the downloaded <code>books_….zip</code>.
        Availability is taken from the “{FEEDME_CATALOG}” catalog. Importing again updates names, prices, add-ons and availability from Feedme;
        SST and print routes set in Craft OS are kept, and no product is deleted.
      </p>

      {error && <p className="rounded bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      {stage.kind === 'pick' && (
        <input type="file" accept=".zip" onChange={(e) => void onFile(e.target.files?.[0])} />
      )}

      {stage.kind === 'preview' && (
        <div className="space-y-3 rounded border border-border p-4">
          <p className="text-sm">
            <b>{stage.fileName}</b>: {stage.payload.products.length} products ({' '}
            {stage.payload.products.filter((p) => p.isAddon).length} add-on items),{' '}
            {stage.payload.products.reduce((n, p) => n + p.variants.length, 0)} variants,{' '}
            {stage.payload.categories.length} categories, {stage.payload.groups.length} add-on groups,{' '}
            {stage.payload.groups.reduce((n, g) => n + g.options.length, 0)} add-on options,{' '}
            {stage.payload.links.length} product ↔ add-on links.
          </p>
          {stage.warnings.length > 0 && (
            <details className="text-sm">
              <summary>{stage.warnings.length} warnings</summary>
              <ul className="mt-2 list-disc pl-5">
                {stage.warnings.slice(0, 100).map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          )}
          <div className="flex gap-2">
            <button className="rounded bg-brown-btn px-4 py-2 text-sm text-white hover:bg-brown-btn-hover" onClick={() => void confirm(stage.payload)}>
              Import {stage.payload.products.length} products
            </button>
            <button className="rounded border border-border px-4 py-2 text-sm" onClick={() => setStage({ kind: 'pick' })}>
              Choose another file
            </button>
          </div>
        </div>
      )}

      {stage.kind === 'importing' && <p className="text-sm">Importing…</p>}

      {stage.kind === 'done' && (
        <div className="space-y-2 rounded border border-border p-4 text-sm">
          <p>
            Synced: {stage.counts.products} products, {stage.counts.variants} variants, {stage.counts.groups} add-on groups,{' '}
            {stage.counts.options} add-on options, {stage.counts.links} links.
          </p>
          <Link to="/menu" className="underline">Open the menu</Link>
        </div>
      )}
    </div>
  )
}
