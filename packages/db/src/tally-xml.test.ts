import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { adapterFor } from "./tally-migration.ts"
import { TallyXmlAdapter, TALLY_XML_LIMITS } from "./tally-xml.ts"

const enc = (value: string) => new TextEncoder().encode(value)

function tallyExport(inner: string, header = "") {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST>${header}</HEADER>
  <BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES></DESC>
    <DATA><TALLYMESSAGE xmlns:UDF="TallyUDF">${inner}</TALLYMESSAGE></DATA>
  </BODY>
</ENVELOPE>`
}

describe("TallyXmlAdapter", () => {
  it("discovers company identity, period and record counts from a Tally export", () => {
    const xml = tallyExport(
      `
      <COMPANY>
        <COMPANYNAME>Kampala Care Pharmacy</COMPANYNAME>
        <CURRENCYNAME>Ugandan Shilling</CURRENCYNAME>
        <SVFROMDATE TYPE="Date">20260101</SVFROMDATE>
        <SVTODATE TYPE="Date">20261231</SVTODATE>
      </COMPANY>
      <STOCKITEM NAME="Paracetamol 500mg"><BASEUNITS>Strip</BASEUNITS></STOCKITEM>
      <STOCKITEM NAME="Amoxicillin 250mg"><BASEUNITS>Capsule</BASEUNITS></STOCKITEM>
      <LEDGER NAME="Sales"><PARENT>Sales Accounts</PARENT></LEDGER>
      <VOUCHER VCHTYPE="Sales" ACTION="Create"><DATE>20260214</DATE></VOUCHER>
      <VOUCHER VCHTYPE="Purchase" ACTION="Create"><DATE>20260215</DATE></VOUCHER>`,
    )

    const discovery = new TallyXmlAdapter().analyse(enc(xml), "tally-export.xml")

    assert.equal(discovery.format, "tally-xml")
    assert.equal(discovery.company, "Kampala Care Pharmacy")
    assert.equal(discovery.currency, "Ugandan Shilling")
    assert.deepEqual(discovery.financialPeriod, { from: "2026-01-01", to: "2026-12-31" })
    assert.equal(discovery.counts.STOCKITEM, 2)
    assert.equal(discovery.counts.LEDGER, 1)
    assert.equal(discovery.counts.VOUCHER, 2)
    assert.equal(discovery.counts.records, 5)
    assert.deepEqual(discovery.warnings, [])
  })

  it("reads company identity from the attribute form used by other export templates", () => {
    const xml = `<ENVELOPE><BODY><DATA><TALLYMESSAGE><COMPANY NAME="Nakawa Pharmacy"/><STOCKITEM NAME="x"/></TALLYMESSAGE></DATA></BODY></ENVELOPE>`
    const discovery = new TallyXmlAdapter().analyse(enc(xml), "export.xml")
    assert.equal(discovery.company, "Nakawa Pharmacy")
    assert.equal(discovery.counts.STOCKITEM, 1)
    assert.ok(discovery.warnings.includes("COMPANY_IDENTITY_MISSING") === false)
  })

  it("warns rather than guessing when the company identity is absent", () => {
    const xml = tallyExport(`<STOCKITEM NAME="x"/>`)
    const discovery = new TallyXmlAdapter().analyse(enc(xml), "export.xml")
    assert.equal(discovery.company, undefined)
    assert.ok(discovery.warnings.includes("COMPANY_IDENTITY_MISSING"))
  })

  it("warns when the financial period is not a Tally date", () => {
    const xml = `<?xml version="1.0"?>
<ENVELOPE><BODY><DATA><TALLYMESSAGE><COMPANY><COMPANYNAME>X</COMPANYNAME><SVFROMDATE>1 Jan 2026</SVFROMDATE></COMPANY><STOCKITEM NAME="a"/></TALLYMESSAGE></DATA></BODY></ENVELOPE>`
    const discovery = new TallyXmlAdapter().analyse(enc(xml), "e.xml")
    assert.equal(discovery.financialPeriod, undefined)
    assert.ok(discovery.warnings.includes("FINANCIAL_PERIOD_UNREADABLE"))
  })

  it("reports an envelope with no TALLYMESSAGE instead of returning a clean zero", () => {
    const xml = `<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY></BODY></ENVELOPE>`
    const discovery = new TallyXmlAdapter().analyse(enc(xml), "e.xml")
    assert.ok(discovery.warnings.includes("NO_TALLY_MESSAGES"))
    assert.equal(discovery.counts.records, undefined)
  })

  it("flags a TALLYMESSAGE containing nothing it recognises", () => {
    const xml = tallyExport(`<SOMETHINGELSE NAME="x"/>`)
    const discovery = new TallyXmlAdapter().analyse(enc(xml), "e.xml")
    assert.ok(discovery.warnings.includes("NO_RECOGNISED_RECORDS"))
  })

  it("decodes the five predefined entities and nothing else", () => {
    const xml = tallyExport(`<COMPANY><COMPANYNAME>Mwangi &amp; Sons</COMPANYNAME></COMPANY><STOCKITEM NAME="a"/>`)
    const discovery = new TallyXmlAdapter().analyse(enc(xml), "e.xml")
    assert.equal(discovery.company, "Mwangi & Sons")
  })

  describe("input rejection", () => {
    it("refuses a DOCTYPE, which is what closes XXE and entity expansion", () => {
      const xml = `<?xml version="1.0"?>
<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]>
<ENVELOPE><BODY><DATA><TALLYMESSAGE><STOCKITEM NAME="&lol2;"/></TALLYMESSAGE></DATA></BODY></ENVELOPE>`
      assert.throws(() => new TallyXmlAdapter().analyse(enc(xml), "e.xml"), /MIGRATION_XML_ENTITIES_REJECTED/)
    })

    it("refuses an ENTITY declaration even without a DOCTYPE", () => {
      const xml = `<ENVELOPE><!ENTITY x SYSTEM "file:///etc/passwd">${"<STOCKITEM/>"}</ENVELOPE>`
      assert.throws(() => new TallyXmlAdapter().analyse(enc(xml), "e.xml"), /MIGRATION_XML_ENTITIES_REJECTED/)
    })

    it("still accepts XML comments, which are not declarations", () => {
      const xml = tallyExport(`<!-- a note --><STOCKITEM NAME="a"/>`)
      const discovery = new TallyXmlAdapter().analyse(enc(xml), "e.xml")
      assert.equal(discovery.counts.STOCKITEM, 1)
    })

    // Stripping comments used to be `<!--[\s\S]*?-->` under a global flag, which
    // rescans to the end of the document from every start marker.
    it("strips adversarial comments in linear time (CodeQL js/polynomial-redos)", () => {
      const unclosed = enc("<!--".repeat(50_000) + "<ENVELOPE/>")
      const started = Date.now()
      assert.throws(() => new TallyXmlAdapter().analyse(unclosed, "e.xml"), /MIGRATION_XML_ENTITIES_REJECTED/)
      assert.ok(Date.now() - started < 200, "stripping 50k comment markers must not be quadratic")
    })

    it("refuses an empty file", () => {
      assert.throws(() => new TallyXmlAdapter().analyse(new Uint8Array(), "e.xml"), /MIGRATION_EMPTY_FILE/)
    })

    it("refuses a file over the size bound", () => {
      const oversized = new Uint8Array(TALLY_XML_LIMITS.MAX_BYTES + 1)
      assert.throws(() => new TallyXmlAdapter().analyse(oversized, "e.xml"), /MIGRATION_FILE_TOO_LARGE/)
    })

    it("refuses bytes that are not UTF-8", () => {
      const invalid = new Uint8Array([0x3c, 0x45, 0xff, 0xfe, 0x3e])
      assert.throws(() => new TallyXmlAdapter().analyse(invalid, "e.xml"), /MIGRATION_XML_NOT_UTF8/)
    })

    it("refuses content with no tags at all", () => {
      assert.throws(() => new TallyXmlAdapter().analyse(enc("not xml"), "e.xml"), /MIGRATION_XML_MALFORMED/)
    })

    it("refuses an invalid filename", () => {
      assert.throws(() => new TallyXmlAdapter().analyse(enc("<ENVELOPE/>"), "bad\nname.xml"), /MIGRATION_INVALID_FILENAME/)
    })
  })

  it("bounds the length of any captured single value", () => {
    const longName = "A".repeat(1000)
    const xml = tallyExport(`<COMPANY><COMPANYNAME>${longName}</COMPANYNAME></COMPANY><STOCKITEM NAME="a"/>`)
    const discovery = new TallyXmlAdapter().analyse(enc(xml), "e.xml")
    assert.equal(discovery.company?.length, TALLY_XML_LIMITS.MAX_CAPTURE)
  })
})

describe("adapterFor", () => {
  it("routes .xml to the Tally XML adapter", () => {
    assert.ok(adapterFor("TallyExport.xml") instanceof TallyXmlAdapter)
  })

  it("routes by XML mime type even without an extension", () => {
    assert.ok(adapterFor("upload", "text/xml") instanceof TallyXmlAdapter)
    assert.ok(adapterFor("upload", "application/xml") instanceof TallyXmlAdapter)
  })

  it("still routes json and csv as before", () => {
    assert.equal(adapterFor("masters.json").format, "tally-json")
    assert.equal(adapterFor("products.csv").format, "csv")
  })

  it("still refuses formats it has no adapter for", () => {
    assert.throws(() => adapterFor("backup.zip"), /MIGRATION_UNSUPPORTED_FILE_TYPE/)
    assert.throws(() => adapterFor("books.xlsx"), /MIGRATION_UNSUPPORTED_FILE_TYPE/)
  })
})
