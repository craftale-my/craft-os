/** Big tap target that opens the camera (falls back to the file picker). */
export default function PhotoButton({ file, onFile, title, hint, required }: {
  file: File | null
  onFile: (f: File | null) => void
  title: string
  hint: string
  required?: boolean
}) {
  return (
    <label
      className={`flex items-center gap-3 rounded-2xl p-3.5 cursor-pointer border ${
        file ? 'border-[#B9D6C2] bg-[#EBF5EE]'
          : required ? 'border-dashed border-[#CDB89C] bg-white border-[1.5px]' : 'border-[#EDE5D8] bg-white'
      }`}
    >
      <span className={`w-12 h-12 rounded-xl grid place-items-center shrink-0 ${file ? 'bg-white' : 'bg-[#F5EDE0]'}`}>
        {file ? (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#3D7A50" strokeWidth="2.4" aria-hidden><path d="M5 12l5 5 9-10" /></svg>
        ) : (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#6B4C35" strokeWidth="2" aria-hidden>
            <path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" />
          </svg>
        )}
      </span>
      <span className="min-w-0">
        <span className="block font-bold text-[15px] text-brown-dark">{file ? `${title} added` : title}</span>
        <span className="block text-xs text-brown-muted truncate">{file ? 'Tap to retake' : hint}</span>
      </span>
      <input
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        onChange={e => onFile(e.target.files?.[0] ?? null)}
      />
    </label>
  )
}
