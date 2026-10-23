import type { ImportCatalog } from './feedmeExport'

/** What the person types before an import overwrites catalogs that already exist. */
export const IMPORT_CONFIRM_WORD = 'IMPORT'
/** A re-import resets the menu to Feedme (as Feedme itself has one master and no merge).
 *  This says exactly what is overwritten, deleted or reset, and what is kept, so nobody
 *  presses Import without knowing. Checked against menu_import / menu_import_catalogs
 *  (migration-2026-10-24-pos-catalogs-fn.sql). */
export const MASTER_WARNING_INTRO =
  'Craft OS is the master of the menu. Importing again resets everything that came from Feedme back to Feedme\'s version:'
export const MASTER_WARNING_LOSSES: readonly string[] = [
  'Every imported product\'s name, description, internal name, category, add-on flag, takeaway fee and order are overwritten, and imported products you switched off come back on.',
  'Every variant name and price Feedme lists is overwritten (switched-off ones come back on); variants of an imported product that you added here are switched off.',
  'Categories are matched by name: a category you renamed here comes back under its Feedme name and the imported products move back into it; categories\' order is reset and categories you switched off come back on.',
  'Imported add-on groups get their name, minimum, maximum and stackable setting overwritten, and groups you switched off come back on.',
  'Every option of an imported add-on group is deleted and recreated: option edits and option prices in all catalogs are lost, and the options get new ids.',
  'The add-on groups linked to each imported product are replaced with Feedme\'s, including groups made here.',
  'Catalogs Feedme lists are overwritten (a catalog made here with the same name is taken over): catalogs you switched off come back on and their order is reset; the products each one sells, whether they are sold at the counter only or also by QR, their order and their variant prices are overwritten; every other product in that catalog, including ones made only here, is hidden in it.',
]
export const MASTER_WARNING_KEPT =
  'Kept: SST rates and print routes, products, add-on groups and catalogs made only in Craft OS, catalogs Feedme does not list, ' +
  'each branch\'s catalog settings and past orders. Catalogs made here keep their prices but may lack a price for a variant ' +
  'Feedme brings back — the Catalogs page counts those products.'
export const MASTER_WARNING =
  [MASTER_WARNING_INTRO, ...MASTER_WARNING_LOSSES, MASTER_WARNING_KEPT].join(' ')

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
