import type { ImportCatalog } from './feedmeExport'

/** What the person types before an import overwrites catalogs that already exist. */
export const IMPORT_CONFIRM_WORD = 'IMPORT'
/** A re-import resets the menu to Feedme (as Feedme itself has one master and no merge).
 *  This says exactly what is lost, so nobody presses Import without knowing. */
export const MASTER_WARNING =
  'Craft OS is the master of the menu. Importing again resets it to Feedme: product names, prices and which products ' +
  'each Feedme catalog sells are overwritten; add-on options added here to Feedme add-on groups are deleted with their ' +
  'catalog prices; options, products and categories you switched off come back on; variants added here are switched ' +
  'off; the add-on groups linked to each imported product are replaced with Feedme\'s. Catalogs made here keep their ' +
  'prices but may lack a price for a variant Feedme brings back — the Catalogs page counts those products.'

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
