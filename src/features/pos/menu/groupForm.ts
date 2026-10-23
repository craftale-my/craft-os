// src/features/pos/menu/groupForm.ts
/** The add-on group editor's form: pure, so every rule is tested. menu_save_group
 *  checks all of it again with the same words. An option is never deleted (orders
 *  name it): it is switched off ('hidden'). */
import type { Availability } from './feedmeExport'
import type { GroupDetail, GroupPayload } from './menuEditorApi'
import { cleanName, inputToSen, moveItem, nameProblem, nextRef, senToInput } from './menuForms'

/** An option row. Catalog prices are box text by catalog id; blank = the option's own price. */
export interface OptionForm {
  ref: string
  id: string | null
  name: string
  price: string
  productId: string | null
  isDefault: boolean
  availability: Availability
  catalogPrices: Record<string, string>
}
export interface GroupForm {
  id: string | null
  name: string
  min: string
  max: string
  stackable: boolean
  isActive: boolean
  options: OptionForm[]
}
export type GroupSection = 'details' | 'options'
export interface GroupProblem { section: GroupSection; message: string }

export const MAX_OPTIONS = 100
export const OPTION_AVAILABILITY_LABELS: Record<Availability, string> = {
  all: 'Counter + QR',
  counter_only: 'Counter only',
  hidden: 'Off',
}

export function emptyGroupForm(): GroupForm {
  return { id: null, name: '', min: '0', max: '1', stackable: false, isActive: true, options: [] }
}

export function groupFormFromDetail(d: GroupDetail): GroupForm {
  return {
    id: d.id, name: d.name, min: String(d.min), max: String(d.max), stackable: d.stackable, isActive: d.isActive,
    options: d.options.map((o) => ({
      ref: o.id, id: o.id, name: o.name, price: senToInput(o.priceDeltaSen), productId: o.productId,
      isDefault: o.isDefault, availability: o.availability,
      catalogPrices: Object.fromEntries(Object.entries(o.catalogPrices).map(([c, sen]) => [c, senToInput(sen)])),
    })),
  }
}

/** A new option; picking an add-on item names the option after it. */
export function addOption(f: GroupForm, addOn: { id: string; name: string } | null = null): GroupForm {
  return {
    ...f,
    options: [...f.options, {
      ref: nextRef(f.options), id: null, name: addOn?.name ?? '', price: '0.00', productId: addOn?.id ?? null,
      isDefault: false, availability: 'all', catalogPrices: {},
    }],
  }
}

export function updateOption(
  f: GroupForm, ref: string, patch: Partial<Pick<OptionForm, 'name' | 'price' | 'productId' | 'isDefault' | 'availability'>>,
): GroupForm {
  return { ...f, options: f.options.map((o) => (o.ref === ref ? { ...o, ...patch } : o)) }
}

export function moveOption(f: GroupForm, index: number, delta: number): GroupForm {
  return { ...f, options: moveItem(f.options, index, delta) }
}

/** Only an option that was never saved can be removed; a saved one is switched off. */
export function removeNewOption(f: GroupForm, ref: string): GroupForm {
  if (f.options.find((o) => o.ref === ref)?.id !== null) return f
  return { ...f, options: f.options.filter((o) => o.ref !== ref) }
}

export function setOptionCatalogPrice(f: GroupForm, ref: string, catalogId: string, text: string): GroupForm {
  return { ...f, options: f.options.map((o) => (o.ref === ref ? { ...o, catalogPrices: { ...o.catalogPrices, [catalogId]: text } } : o)) }
}

const whole = (text: string): number | null => (/^\d{1,2}$/.test(text.trim()) ? Number(text.trim()) : null)
const optionLabel = (o: OptionForm) => cleanName(o.name) || 'the new option'

/** Every problem that would stop a save, in section order. */
export function groupProblems(f: GroupForm, catalogName: (id: string) => string): GroupProblem[] {
  const out: GroupProblem[] = []
  const add = (section: GroupSection, message: string | null) => { if (message) out.push({ section, message }) }
  const min = whole(f.min)
  const max = whole(f.max)
  const on = f.options.filter((o) => o.availability !== 'hidden').length

  add('details', nameProblem('Add-on group', f.name, 80))
  if (min === null) add('details', 'Min must be a whole number from 0 to 99')
  if (max === null || max < 1) add('details', 'Max must be a whole number from 1 to 99')
  if (min !== null && max !== null && max >= 1) {
    if (min > max) add('details', 'Min cannot be more than max')
    else if (f.isActive && min > on) add('details', `Min is ${min} but only ${on} ${on === 1 ? 'option is' : 'options are'} on`)
  }

  if (f.options.length > MAX_OPTIONS) add('options', `Too many options (at most ${MAX_OPTIONS})`)
  for (const o of f.options) {
    add('options', nameProblem('Option', o.name, 80))
    if (inputToSen(o.price) === null) add('options', `Enter the price of ${optionLabel(o)} in RM, e.g. 1.00`)
    if (o.isDefault && o.availability === 'hidden') add('options', `A switched-off option cannot be the default: ${optionLabel(o)}`)
    for (const [catalogId, text] of Object.entries(o.catalogPrices)) {
      if (text.trim() !== '' && inputToSen(text) === null) {
        add('options', `${catalogName(catalogId)}: the price of ${optionLabel(o)} is not an amount in RM`)
      }
    }
  }
  const defaults = f.options.filter((o) => o.isDefault).length
  if (max !== null && max >= 1 && defaults > max) {
    add('options', `At most ${max} ${max === 1 ? 'option can be' : 'options can be'} the default`)
  }
  return out
}

/** What menu_save_group takes. Call it only when groupProblems() is empty. */
export function groupPayload(f: GroupForm): GroupPayload {
  const sen = (text: string): number => {
    const v = inputToSen(text)
    if (v === null) throw new Error(`"${text}" is not an amount in RM`)
    return v
  }
  return {
    id: f.id,
    name: cleanName(f.name),
    min: Number(f.min.trim()),
    max: Number(f.max.trim()),
    stackable: f.stackable,
    isActive: f.isActive,
    options: f.options.map((o) => ({
      ref: o.ref, id: o.id, name: cleanName(o.name), priceDeltaSen: sen(o.price), productId: o.productId,
      isDefault: o.isDefault, availability: o.availability,
    })),
    catalogPrices: f.options.flatMap((o) =>
      Object.entries(o.catalogPrices)
        .filter(([, text]) => text.trim() !== '')
        .map(([catalogId, text]) => ({ catalogId, ref: o.ref, priceDeltaSen: sen(text) }))),
  }
}
