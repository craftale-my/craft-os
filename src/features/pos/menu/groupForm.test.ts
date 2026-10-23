import { describe, expect, it } from 'vitest'
import {
  addOption, emptyGroupForm, groupFormDirty, groupFormFromDetail, groupPayload, groupProblems, moveOption, removeNewOption,
  setOptionCatalogPrice, updateOption, type GroupForm,
} from './groupForm'
import type { GroupDetail } from './menuEditorApi'

const catalogName = (id: string) => ({ grab: 'Grab Food', cafe: 'Craft Cafe' } as Record<string, string>)[id] ?? id
const messages = (f: GroupForm) => groupProblems(f, catalogName).map((p) => p.message)

const detail: GroupDetail = {
  id: 'g1', name: 'Milk', min: 0, max: 1, stackable: false, isActive: true, feedmeGroupId: 'fg-1',
  options: [
    { id: 'o-full', name: 'Full cream', priceDeltaSen: 0, productId: null, isDefault: true, availability: 'all', catalogPrices: {} },
    { id: 'o-oat', name: 'Oat milk', priceDeltaSen: 200, productId: 'p-oat', isDefault: false, availability: 'all', catalogPrices: { grab: 300 } },
  ],
  usedBy: [{ id: 'p1', name: 'Latte' }],
}
const saved = () => groupFormFromDetail(detail)

describe('the form of a saved group', () => {
  it('shows prices as RM text, catalog overrides by catalog, and has no problems', () => {
    const f = saved()
    expect(f.min).toBe('0')
    expect(f.options[1]).toEqual({
      ref: 'o-oat', id: 'o-oat', name: 'Oat milk', price: '2.00', productId: 'p-oat', isDefault: false,
      availability: 'all', catalogPrices: { grab: '3.00' },
    })
    expect(messages(f)).toEqual([])
  })

  it('turns back into the payload: the overrides typed are the whole set', () => {
    let f = setOptionCatalogPrice(saved(), 'o-full', 'cafe', '0.50')
    f = setOptionCatalogPrice(f, 'o-oat', 'grab', '')                        // blank = back to the option's own price
    expect(groupPayload(f)).toEqual({
      id: 'g1', name: 'Milk', min: 0, max: 1, stackable: false, isActive: true,
      options: [
        { ref: 'o-full', id: 'o-full', name: 'Full cream', priceDeltaSen: 0, productId: null, isDefault: true, availability: 'all' },
        { ref: 'o-oat', id: 'o-oat', name: 'Oat milk', priceDeltaSen: 200, productId: 'p-oat', isDefault: false, availability: 'all' },
      ],
      catalogPrices: [{ catalogId: 'cafe', ref: 'o-full', priceDeltaSen: 50 }],
    })
  })
})

describe('unsaved changes', () => {
  it('typing a catalog price and clearing it again is not a change', () => {
    const typed = setOptionCatalogPrice(saved(), 'o-full', 'cafe', '0.50')
    expect(groupFormDirty(typed, saved())).toBe(true)
    expect(groupFormDirty(setOptionCatalogPrice(typed, 'o-full', 'cafe', ''), saved())).toBe(false)
    expect(groupFormDirty(setOptionCatalogPrice(saved(), 'o-oat', 'grab', ''), saved())).toBe(true)   // a saved override cleared
    expect(groupFormDirty(updateOption(saved(), 'o-oat', { name: 'Oat' }), saved())).toBe(true)
  })
})

describe('the payload of a new group', () => {
  it('has no ids, and names its options by new-N refs', () => {
    let f = { ...emptyGroupForm(), name: '  Sugar  ' }
    f = updateOption(addOption(f), 'new-1', { name: 'Less sugar' })
    f = setOptionCatalogPrice(addOption(f, { id: 'p-honey', name: 'Honey' }), 'new-2', 'grab', '1.50')
    expect(groupPayload(f)).toEqual({
      id: null, name: 'Sugar', min: 0, max: 1, stackable: false, isActive: true,
      options: [
        { ref: 'new-1', id: null, name: 'Less sugar', priceDeltaSen: 0, productId: null, isDefault: false, availability: 'all' },
        { ref: 'new-2', id: null, name: 'Honey', priceDeltaSen: 0, productId: 'p-honey', isDefault: false, availability: 'all' },
      ],
      catalogPrices: [{ catalogId: 'grab', ref: 'new-2', priceDeltaSen: 150 }],
    })
  })
})

describe('options', () => {
  it('adds a blank option or one named after an add-on item, and moves it', () => {
    let f = addOption(saved())
    expect(f.options[2]).toMatchObject({ ref: 'new-1', id: null, name: '', price: '0.00', productId: null, availability: 'all' })
    f = addOption(f, { id: 'p-soy', name: 'Soy milk' })
    expect(f.options[3]).toMatchObject({ ref: 'new-2', name: 'Soy milk', productId: 'p-soy' })
    expect(moveOption(f, 3, -3).options.map((o) => o.ref)).toEqual(['new-2', 'o-full', 'o-oat', 'new-1'])
  })

  it('removes only an unsaved option; a saved one is switched off instead', () => {
    const f = addOption(saved())
    expect(removeNewOption(f, 'new-1').options).toHaveLength(2)
    expect(removeNewOption(f, 'o-oat')).toBe(f)
  })

  it('needs a name and an amount, keeps defaults on and within max, and checks typed catalog prices', () => {
    let f = updateOption(addOption(saved()), 'new-1', { price: 'free' })
    expect(messages(f)).toEqual(['Option name is required', 'Enter the price of the new option in RM, e.g. 1.00'])
    f = updateOption(saved(), 'o-full', { availability: 'hidden' })
    expect(messages(f)).toEqual(['A switched-off option cannot be the default: Full cream'])
    f = updateOption(saved(), 'o-oat', { isDefault: true })
    expect(messages(f)).toEqual(['At most 1 option can be the default'])
    f = { ...updateOption(saved(), 'o-oat', { isDefault: true }), max: '1' }
    expect(groupProblems(f, catalogName).every((p) => p.section === 'options')).toBe(true)
    f = setOptionCatalogPrice(saved(), 'o-oat', 'grab', '3.333')
    expect(messages(f)).toEqual(['Grab Food: the price of Oat milk is not an amount in RM'])
  })
})

describe('min and max', () => {
  it('uses the server\'s words', () => {
    expect(messages({ ...saved(), min: '-1' })).toEqual(['Min must be a whole number from 0 to 99'])
    expect(messages({ ...saved(), min: '1.5' })).toEqual(['Min must be a whole number from 0 to 99'])
    expect(messages({ ...saved(), max: '0' })).toEqual(['Max must be a whole number from 1 to 99'])
    expect(messages({ ...saved(), min: '100', max: '100' })).toEqual([
      'Min must be a whole number from 0 to 99', 'Max must be a whole number from 1 to 99',
    ])
    expect(messages({ ...saved(), min: '2', max: '1' })).toEqual(['Min cannot be more than max'])
  })

  it('min cannot ask for more options than are on (only for a group that is on)', () => {
    expect(messages({ ...saved(), min: '3', max: '3' })).toEqual(['Min is 3 but only 2 options are on'])
    const one = updateOption(saved(), 'o-oat', { availability: 'hidden' })
    expect(messages({ ...one, min: '2', max: '2' })).toEqual(['Min is 2 but only 1 option is on'])
    expect(messages({ ...one, min: '2', max: '2', isActive: false })).toEqual([])
  })

  it('a new group starts at choose 0–1 and only needs a name', () => {
    expect(messages(emptyGroupForm())).toEqual(['Add-on group name is required'])
  })
})
