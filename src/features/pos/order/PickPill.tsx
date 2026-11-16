// src/features/pos/order/PickPill.tsx
/** The small amber pill of the menu picks: "Popular" on a product, "Most picked" on an option. */
export default function PickPill({ text }: { text: 'Popular' | 'Most picked' }) {
  return (
    <span className="ml-1.5 inline-block whitespace-nowrap rounded-full bg-amber-100 px-2 py-0.5 align-middle text-[11px] font-semibold text-amber-800">
      {text}
    </span>
  )
}
