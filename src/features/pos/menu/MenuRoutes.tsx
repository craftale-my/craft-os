// src/features/pos/menu/MenuRoutes.tsx
import { Navigate, Route, Routes } from 'react-router-dom'
import ProductListPage from './ProductListPage'
import MenuImportPage from './MenuImportPage'

/** Everything under /menu (App.tsx gates it on Edit menu). */
export default function MenuRoutes() {
  return (
    <Routes>
      <Route index element={<ProductListPage />} />
      <Route path="import" element={<MenuImportPage />} />
      <Route path="*" element={<Navigate to="/menu" replace />} />
    </Routes>
  )
}
