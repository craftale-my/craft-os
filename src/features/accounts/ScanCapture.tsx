import { useEffect, useRef, useState } from 'react'
import { Camera, FileUp, RotateCw, ArrowUp, Trash2, FileText } from 'lucide-react'
import { canvasesToPdf, canvasForAi, loadImage, processPage, thumbnail, blobToBase64, type ScanPage, type ScanMode, type AiImage } from './imaging'

/** What the user has picked: phone photos to clean up, or a PDF kept as it is. */
export interface ScanValue {
  pages: ScanPage[]
  pdf: File | null
}

export const EMPTY_SCAN: ScanValue = { pages: [], pdf: null }
export const scanIsEmpty = (v: ScanValue) => !v.pages.length && !v.pdf

// processPage on a 2000 px photo takes a moment; remember the result per page + settings.
const cache = new WeakMap<ScanPage, { key: string; canvas: HTMLCanvasElement }>()
export function processed(p: ScanPage): HTMLCanvasElement {
  const key = `${p.rot}|${p.mode}`
  const hit = cache.get(p)
  if (hit && hit.key === key) return hit.canvas
  const canvas = processPage(p)
  cache.set(p, { key, canvas })
  return canvas
}

/** The scan as one A4 PDF (photos) or the original PDF. */
export async function scanToPdf(v: ScanValue): Promise<Blob | null> {
  if (v.pdf) return v.pdf
  if (!v.pages.length) return null
  return canvasesToPdf(v.pages.map(processed))
}

/** The scan in the form the AI reads: a PDF as-is, photos as shrunk JPEGs. */
export async function scanForAi(v: ScanValue): Promise<{ images?: AiImage[]; pdf?: string }> {
  if (v.pdf) return { pdf: await blobToBase64(v.pdf) }
  return { images: v.pages.slice(0, 8).flatMap(p => canvasForAi(processed(p))) }
}

const MODES: [ScanMode, string][] = [['doc', 'Document'], ['bw', 'B&W'], ['color', 'Original']]

function Thumb({ page, index, onChange, onUp, onDelete }: {
  page: ScanPage
  index: number
  onChange: (p: ScanPage) => void
  onUp: () => void
  onDelete: () => void
}) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const c = thumbnail(processed(page), 260)
    c.className = 'w-full h-auto rounded bg-white'
    el.replaceChildren(c)
  }, [page])

  return (
    <div className="w-[132px] rounded-lg border border-line bg-cream p-1.5 space-y-1.5">
      <div ref={box} aria-label={`Page ${index + 1}`} />
      <div className="flex rounded-md border border-line overflow-hidden" role="group" aria-label="Clean-up">
        {MODES.map(([m, label]) => (
          <button key={m} type="button" aria-pressed={page.mode === m}
            onClick={() => onChange({ ...page, mode: m })}
            className={`flex-1 text-[10px] py-1 ${page.mode === m ? 'bg-brown-btn text-white' : 'bg-white text-brown-muted'}`}>
            {label}
          </button>
        ))}
      </div>
      <div className="flex justify-between">
        <button type="button" title="Rotate" aria-label="Rotate" onClick={() => onChange({ ...page, rot: (page.rot + 90) % 360 })}
          className="p-1 rounded hover:bg-white text-brown-muted"><RotateCw size={14} /></button>
        <button type="button" title="Move earlier" aria-label="Move earlier" disabled={index === 0} onClick={onUp}
          className="p-1 rounded hover:bg-white text-brown-muted disabled:opacity-30"><ArrowUp size={14} /></button>
        <button type="button" title="Remove" aria-label="Remove page" onClick={onDelete}
          className="p-1 rounded hover:bg-white text-bad"><Trash2 size={14} /></button>
      </div>
    </div>
  )
}

/**
 * Photograph or pick a paper invoice / receipt. Photos get the shadow-removal
 * and contrast clean-up and become one A4 PDF; a PDF is kept as it is.
 */
export function ScanCapture({ value, onChange, allowPdf = true }: {
  value: ScanValue
  onChange: (v: ScanValue) => void
  allowPdf?: boolean
}) {
  const [error, setError] = useState('')
  const cam = useRef<HTMLInputElement>(null)
  const pick = useRef<HTMLInputElement>(null)

  async function add(files: File[]) {
    setError('')
    const pdf = files.find(f => f.type === 'application/pdf')
    if (pdf) {
      onChange({ pages: [], pdf })
      return
    }
    const pages = [...value.pages]
    for (const f of files) {
      try {
        pages.push({ img: await loadImage(f), rot: 0, mode: 'doc' })
      } catch {
        setError(`Could not read ${f.name}. Try a JPG or PNG photo.`)
      }
    }
    onChange({ pages, pdf: null })
  }

  const setPage = (i: number, p: ScanPage) => onChange({ ...value, pages: value.pages.map((x, j) => (j === i ? p : x)) })
  const move = (i: number) => {
    const pages = [...value.pages]
    ;[pages[i - 1], pages[i]] = [pages[i], pages[i - 1]]
    onChange({ ...value, pages })
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => cam.current?.click()}
          className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-brown-btn text-white text-xs font-semibold hover:bg-brown-btn-hover">
          <Camera size={14} /> Take photo
        </button>
        <button type="button" onClick={() => pick.current?.click()}
          className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-border-mid bg-white text-brown-brand text-xs font-semibold hover:bg-cream">
          <FileUp size={14} /> {allowPdf ? 'Choose photos / PDF' : 'Choose photos'}
        </button>
        <span className="text-xs text-brown-faint">
          {value.pdf ? '1 PDF' : value.pages.length ? `${value.pages.length} page${value.pages.length > 1 ? 's' : ''}` : 'No pages yet'}
        </span>
        <input ref={cam} type="file" accept="image/*" capture="environment" hidden
          onChange={e => { add([...(e.target.files ?? [])]); e.target.value = '' }} />
        <input ref={pick} type="file" accept={allowPdf ? 'image/*,application/pdf' : 'image/*'} multiple hidden
          onChange={e => { add([...(e.target.files ?? [])]); e.target.value = '' }} />
      </div>
      {error && <p className="text-xs text-bad">{error}</p>}
      {value.pdf && (
        <div className="flex items-center gap-2 text-xs text-brown-dark bg-cream rounded-lg px-3 py-2">
          <FileText size={14} className="text-brown-muted" />
          <span className="flex-1 truncate">{value.pdf.name}</span>
          <button type="button" className="text-bad font-semibold" onClick={() => onChange(EMPTY_SCAN)}>Remove</button>
        </div>
      )}
      {value.pages.length > 0 && (
        <>
          <div className="flex flex-wrap gap-2">
            {value.pages.map((p, i) => (
              <Thumb key={i} page={p} index={i} onChange={np => setPage(i, np)} onUp={() => move(i)}
                onDelete={() => onChange({ ...value, pages: value.pages.filter((_, j) => j !== i) })} />
            ))}
          </div>
          <p className="text-[11px] text-brown-faint">Shadows are removed and contrast raised. Use Original for colour photos. Several photos make one multi-page PDF.</p>
        </>
      )}
    </div>
  )
}
