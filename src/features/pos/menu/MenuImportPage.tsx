import { useState } from 'react'
import { Link } from 'react-router-dom'
import { buildCatalogsImport, readFeedmeExport, type CatalogsImport } from './feedmeExport'
import { countCatalogs, importFeedme, type ImportReport } from './menuApi'
import { IMPORT_CONFIRM_WORD, MASTER_WARNING, canImport, catalogSummary } from './importView'

type Stage =
  | { kind: 'pick' }
  | { kind: 'preview'; fileName: string; payload: CatalogsImport; warnings: string[]; existingCatalogs: number }
  | { kind: 'importing' }
  | { kind: 'done'; report: ImportReport }

const th = 'px-3 py-1 text-left font-normal text-gray-500'
const td = 'px-3 py-1'

export default function MenuImportPage() {
  const [stage, setStage] = useState<Stage>({ kind: 'pick' })
  const [error, setError] = useState<string | null>(null)
  const [typed, setTyped] = useState('')

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
      const { payload, warnings } = buildCatalogsImport(files)
      const existingCatalogs = await countCatalogs()
      setTyped('')
      setStage({ kind: 'preview', fileName: file.name, payload, warnings, existingCatalogs })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStage({ kind: 'pick' })
    }
  }

  const confirm = async (payload: CatalogsImport) => {
    setStage({ kind: 'importing' })
    try {
      setStage({ kind: 'done', report: await importFeedme(payload) })
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
        The import loads every product from the “Default Catalog” sheet and every Feedme catalog with its own products
        and prices. SST and print routes set in Craft OS are kept, and nothing is deleted: a product a catalog no longer
        sells is hidden in it. Branch assignments are not imported — choose each branch’s catalogs in POS settings.
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
            {stage.payload.links.length} product ↔ add-on links, {stage.payload.catalogs.length} catalogs.
          </p>
          <table className="w-full text-sm">
            <thead><tr><th className={th}>Catalog</th><th className={th}>Products</th><th className={th}>Counter only</th><th className={th}>Own add-on prices</th></tr></thead>
            <tbody>
              {stage.payload.catalogs.map(catalogSummary).map((c) => (
                <tr key={c.name} className="border-t border-border">
                  <td className={td}>{c.name}</td><td className={td}>{c.products}</td>
                  <td className={td}>{c.counterOnly}</td><td className={td}>{c.optionPrices}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
          <p role="alert" className="rounded bg-amber-50 p-3 text-sm text-amber-900">{MASTER_WARNING}</p>
          {stage.existingCatalogs > 0 && (
            <label className="block text-sm">
              {stage.existingCatalogs} catalog{stage.existingCatalogs === 1 ? '' : 's'} already exist. Type <b>{IMPORT_CONFIRM_WORD}</b> to overwrite them.
              <input className="ml-2 rounded border border-border px-2 py-1" value={typed} onChange={(e) => setTyped(e.target.value)} />
            </label>
          )}
          <div className="flex gap-2">
            <button
              disabled={!canImport(stage.existingCatalogs, typed)}
              className="rounded bg-brown-btn px-4 py-2 text-sm text-white hover:bg-brown-btn-hover disabled:opacity-40"
              onClick={() => void confirm(stage.payload)}
            >
              Import {stage.payload.products.length} products and {stage.payload.catalogs.length} catalogs
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
            Synced: {stage.report.products} products, {stage.report.variants} variants, {stage.report.groups} add-on groups,{' '}
            {stage.report.options} add-on options, {stage.report.links} links.
          </p>
          <table className="w-full">
            <thead><tr><th className={th}>Catalog</th><th className={th}>Products</th><th className={th}>Prices</th><th className={th}>Own add-on prices</th></tr></thead>
            <tbody>
              {stage.report.catalogs.map((c) => (
                <tr key={c.name} className="border-t border-border">
                  <td className={td}>{c.name}</td><td className={td}>{c.products}</td>
                  <td className={td}>{c.prices}</td><td className={td}>{c.optionPrices}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>Next: choose each branch’s catalogs in <Link to="/pos/settings" className="underline">POS settings</Link>.</p>
          <Link to="/menu" className="underline">Open the menu</Link>
        </div>
      )}
    </div>
  )
}
