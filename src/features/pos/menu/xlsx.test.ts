// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { readXlsx } from './xlsx'
import { makeXlsx } from './testing/makeXlsx'

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

describe('readXlsx', () => {
  it('reads every sheet by name with inline strings and keeps CJK text', () => {
    const bytes = makeXlsx({
      'Craft Cafe': [['Product ID', 'Name'], ['item_1', 'Salted Egg 咸蛋酱 ']],
      'Grab Food': [['Product ID'], ['item_1']],
    })
    expect(readXlsx(bytes)).toEqual({
      'Craft Cafe': [['Product ID', 'Name'], ['item_1', 'Salted Egg 咸蛋酱 ']],
      'Grab Food': [['Product ID'], ['item_1']],
    })
  })

  it('fills skipped cells with empty strings', () => {
    const bytes = makeXlsx({ S: [['a', '', 'c']] })
    expect(readXlsx(bytes).S).toEqual([['a', '', 'c']])
  })

  it('resolves shared strings and plain numbers', () => {
    const bytes = zipSync({
      'xl/workbook.xml': strToU8(
        `<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets><sheet name="Menu" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      ),
      'xl/_rels/workbook.xml.rels': strToU8(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="/xl/worksheets/sheet1.xml"/></Relationships>`,
      ),
      'xl/sharedStrings.xml': strToU8(`<sst xmlns="${MAIN}"><si><t>Coffee Latte</t></si><si><r><t>Mo</t></r><r><t>cha</t></r></si></sst>`),
      'xl/worksheets/sheet1.xml': strToU8(
        `<worksheet xmlns="${MAIN}"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>13.5</v></c><c r="C1" t="s"><v>1</v></c></row></sheetData></worksheet>`,
      ),
    })
    expect(readXlsx(bytes).Menu).toEqual([['Coffee Latte', '13.5', 'Mocha']])
  })

  it('rejects a file that is not an Excel workbook', () => {
    expect(() => readXlsx(zipSync({ 'hello.txt': strToU8('hi') }))).toThrow('Not an Excel (.xlsx) file')
  })
})
