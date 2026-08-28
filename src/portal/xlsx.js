/* A minimal .xlsx writer.

   An .xlsx is a zip of a few XML parts. This writes exactly the subset TEMPO
   needs — typed dates and numbers, a frozen header, an AutoFilter, and a
   SUBTOTAL row that recalculates when the reader filters — and nothing else.

   Why hand-rolled: the `xlsx` package on npm is pinned at 0.18.5 because
   SheetJS moved distribution off npm, and the prototype-pollution fix never
   shipped there, so `npm i xlsx` installs a known advisory with no upgrade
   path. exceljs drags nine transitive dependencies in to write six columns.
   For an app holding billing data with no dependencies of its own, neither
   trade is worth making for a format we only ever write.

   Entries are STOREd rather than deflated, so no compression API is involved
   at all and this runs unchanged in a browser and under node --test. At a few
   hundred rows the size difference is irrelevant. */

const enc = new TextEncoder()

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  // Excel rejects most control characters outright rather than ignoring them.
  .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')

/* ── zip ─────────────────────────────────────────────────────────────── */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

function crc32(bytes) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

// A fixed DOS timestamp keeps the output byte-identical for identical input,
// which makes the file diffable and the tests deterministic.
const DOS_TIME = 0
const DOS_DATE = (1 << 9) | (1 << 5) | 1   // 1980-01-01

function zipStore(files) {
  const chunks = []
  const central = []
  let offset = 0

  const u16 = (n) => [n & 0xFF, (n >>> 8) & 0xFF]
  const u32 = (n) => [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF]

  for (const { name, data } of files) {
    const nameBytes = enc.encode(name)
    const crc = crc32(data)

    const local = [
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0),
      ...u16(DOS_TIME), ...u16(DOS_DATE),
      ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(nameBytes.length), ...u16(0),
    ]
    chunks.push(new Uint8Array(local), nameBytes, data)

    central.push(new Uint8Array([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0),
      ...u16(DOS_TIME), ...u16(DOS_DATE),
      ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(offset),
    ]), nameBytes)

    offset += local.length + nameBytes.length + data.length
  }

  const centralSize = central.reduce((a, c) => a + c.length, 0)
  const end = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(files.length), ...u16(files.length),
    ...u32(centralSize), ...u32(offset), ...u16(0),
  ])

  const all = [...chunks, ...central, end]
  const total = all.reduce((a, c) => a + c.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const c of all) { out.set(c, at); at += c.length }
  return out
}

/* ── cells ───────────────────────────────────────────────────────────── */

// Excel counts days from 1899-12-30, which absorbs its own 1900 leap-year bug.
// Dates arrive as plain 'YYYY-MM-DD', so this never touches a time zone.
const EPOCH = Date.UTC(1899, 11, 30)

export function dateSerial(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number)
  if (!y || !m || !d) return null
  return (Date.UTC(y, m - 1, d) - EPOCH) / 86400000
}

const colName = (i) => {
  let s = ''
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  }
  return s
}

// Style indexes into the cellXfs list built in STYLES below.
const S = { plain: 0, header: 1, date: 2, number: 3, money: 4, totalLabel: 5, totalNum: 6, totalMoney: 7 }

function cell(ref, value, style, type) {
  if (value === null || value === undefined || value === '') {
    return `<c r="${ref}" s="${style}"/>`
  }
  if (type === 'text') {
    return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`
  }
  return `<c r="${ref}" s="${style}"><v>${value}</v></c>`
}

const formulaCell = (ref, style, formula) =>
  `<c r="${ref}" s="${style}"><f>${esc(formula)}</f></c>`

/* ── parts ───────────────────────────────────────────────────────────── */

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`

const WORKBOOK = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Hours" sheetId="1" r:id="rId1"/><sheet name="Summary" sheetId="2" r:id="rId2"/></sheets>
</workbook>`

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3">
<numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/>
<numFmt numFmtId="165" formatCode="0.00"/>
<numFmt numFmtId="166" formatCode="&quot;$&quot;#,##0.00"/>
</numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top style="thin"/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="8">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>
<xf numFmtId="165" fontId="1" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>
<xf numFmtId="166" fontId="1" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>
</cellXfs>
</styleSheet>`

const WIDTHS = { date: 12, hours: 9, rate: 10, amount: 13, projects: 42, notes: 60 }
const STYLE_FOR = { date: S.date, number: S.number, money: S.money, text: S.plain }
const TOTAL_STYLE_FOR = { number: S.totalNum, money: S.totalMoney }

function sheetXml({ columns, rows, totals }) {
  const cols = columns
    .map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${WIDTHS[c.key] || 14}" customWidth="1"/>`)
    .join('')

  const header = `<row r="1">${columns
    .map((c, i) => cell(`${colName(i)}1`, c.label, S.header, 'text')).join('')}</row>`

  const body = rows.map((row, r) => {
    const n = r + 2
    return `<row r="${n}">${columns.map((c, i) => {
      const ref = `${colName(i)}${n}`
      const v = row[c.key]
      if (c.type === 'date') return cell(ref, dateSerial(v), S.date)
      if (c.type === 'text') return cell(ref, v, S.plain, 'text')
      return cell(ref, v, STYLE_FOR[c.type])
    }).join('')}</row>`
  }).join('')

  const lastData = rows.length + 1
  // The totals row sits below the AutoFilter range on purpose: inside it, a
  // filter could hide the totals themselves. SUBTOTAL(109,…) ignores rows the
  // filter has hidden, so the figure tracks whatever the reader narrows to.
  const totalRowNum = lastData + 1
  const totalsRow = totals
    ? `<row r="${totalRowNum}">${columns.map((c, i) => {
        const ref = `${colName(i)}${totalRowNum}`
        if (i === 0) return cell(ref, 'Total', S.totalLabel, 'text')
        if (!TOTAL_STYLE_FOR[c.type] || c.key === 'rate') {
          return `<c r="${ref}" s="${S.totalLabel}"/>`
        }
        const range = `${colName(i)}2:${colName(i)}${lastData}`
        return formulaCell(ref, TOTAL_STYLE_FOR[c.type], `SUBTOTAL(109,${range})`)
      }).join('')}</row>`
    : ''

  const lastCol = colName(columns.length - 1)
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${cols}</cols>
<sheetData>${header}${body}${totalsRow}</sheetData>
<autoFilter ref="A1:${lastCol}${Math.max(lastData, 1)}"/>
</worksheet>`
}

// Free-form rows of typed cells: the summary sheet is prose and a small table
// rather than a grid, so it takes cells directly instead of columns.
function summarySheet(rows) {
  const body = rows.map((cells, r) => {
    const n = r + 1
    const xml = cells.map((c, i) => {
      const ref = `${colName(i)}${n}`
      if (!c) return `<c r="${ref}"/>`
      if (c.type === 'money') return cell(ref, c.v, c.bold ? S.totalMoney : S.money)
      if (c.type === 'number') return cell(ref, c.v, c.bold ? S.totalNum : S.number)
      if (c.type === 'date') return cell(ref, dateSerial(c.v), S.date)
      return cell(ref, c.v, c.bold ? S.header : S.plain, 'text')
    }).join('')
    return `<row r="${n}">${xml}</row>`
  }).join('')

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<cols><col min="1" max="1" width="38" customWidth="1"/><col min="2" max="2" width="18" customWidth="1"/><col min="3" max="3" width="16" customWidth="1"/></cols>
<sheetData>${body}</sheetData>
</worksheet>`
}

/* ── entry point ─────────────────────────────────────────────────────── */

export function buildWorkbook({ columns, rows, summary }) {
  const part = (name, xml) => ({ name, data: enc.encode(xml) })
  return zipStore([
    part('[Content_Types].xml', CONTENT_TYPES),
    part('_rels/.rels', ROOT_RELS),
    part('xl/workbook.xml', WORKBOOK),
    part('xl/_rels/workbook.xml.rels', WORKBOOK_RELS),
    part('xl/styles.xml', STYLES),
    part('xl/worksheets/sheet1.xml', sheetXml({ columns, rows, totals: true })),
    part('xl/worksheets/sheet2.xml', summarySheet(summary)),
  ])
}
