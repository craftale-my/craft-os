// src/features/pos/menu/MenuRoutes.tsx
import { Navigate, Route, Routes, useParams } from 'react-router-dom'
import ProductListPage from './ProductListPage'
import ProductEditorPage from './ProductEditorPage'
import MenuImportPage from './MenuImportPage'

/** A fresh editor per product: nothing typed for one product can leak into another. */
function ProductEditorRoute() {
  const { id } = useParams<{ id: string }>()
  return <ProductEditorPage key={id ?? 'new'} productId={id ?? null} />
}

/** Everything under /menu (App.tsx gates it on Edit menu). */
export default function MenuRoutes() {
  return (
    <Routes>
      <Route index element={<ProductListPage />} />
      <Route path="products/new" element={<ProductEditorRoute />} />
      <Route path="products/:id" element={<ProductEditorRoute />} />
      <Route path="import" element={<MenuImportPage />} />
      <Route path="*" element={<Navigate to="/menu" replace />} />
    </Routes>
  )
}
