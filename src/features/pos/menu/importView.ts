import type { ImportCatalog } from './feedmeExport'

/** What the person types before an import overwrites catalogs that already exist. */
export const IMPORT_CONFIRM_WORD = 'IMPORT'
export const MASTER_WARNING =
  'Craft OS is the master of the menu. Importing again overwrites names, prices and catalogs you changed here.'

export interface CatalogSummary { name: string; products: number; counterOnly: number; optionPrices: number }

export function catalogSummary(c: ImportCatalog): CatalogSummary {
  return {
    name: c.name,
    products: c.products.length,
    counterOnly: c.products.filter((p) => p.availability === 'counter_only').length,
    optionPrices: c.optionPrices.length,
  }
}

/** A first import needs no typing; once any catalog exists the word must be typed. */
export function canImport(existingCatalogs: number, typed: string): boolean {
  return existingCatalogs === 0 || typed.trim() === IMPORT_CONFIRM_WORD
}
