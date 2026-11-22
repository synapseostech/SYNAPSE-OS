import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { buildSurveillance, epiWeekLabel, epiWeekStart } from "./epi-surveillance.ts"

const NOW = new Date("2026-11-20T09:00:00Z") // Friday, ISO week 47
const DAY = 86_400_000
const at = (weeksAgo: number) => new Date(NOW.getTime() - weeksAgo * 7 * DAY).toISOString()
let n = 0
const dx = (code: string, weeksAgo: number, extra: Record<string, unknown> = {}) => ({ encounter_id: `e${n++}`, stem_code: code, certainty: "confirmed", visit_date: at(weeksAgo), dob: "1990-01-01", sex: "F", district: "Gulu", ...extra })

describe("epidemiological weeks", () => {
  it("start on Monday in Kampala time", () => {
    assert.equal(epiWeekStart("2026-11-20T09:00:00Z"), "2026-11-16")
    // Sunday 22:00 UTC is Monday 01:00 in Kampala
    assert.equal(epiWeekStart("2026-11-22T22:00:00Z"), "2026-11-23")
  })
  it("are labelled ISO-8601", () => {
    assert.equal(epiWeekLabel("2026-11-16"), "2026-W47")
    assert.equal(epiWeekLabel("2026-12-28"), "2026-W53")
    assert.equal(epiWeekLabel("2027-01-04"), "2027-W01")
  })
})

describe("surveillance", () => {
  it("raises an immediate alert for any notifiable case this week", () => {
    const r = buildSurveillance([dx("1A00", 0)], { now: NOW })
    assert.equal(r.alerts[0]?.key, "cholera")
    assert.equal(r.alerts[0]?.level, "immediate")
  })

  it("flags malaria above mean + 2 SD of the previous 8 weeks", () => {
    const rows = []
    for (let w = 1; w <= 8; w += 1) for (let i = 0; i < 4 + (w % 2); i += 1) rows.push(dx("1F40.Z", w))
    for (let i = 0; i < 12; i += 1) rows.push(dx("1F40.Z", 0))
    const r = buildSurveillance(rows, { now: NOW })
    const a = r.alerts.find((x) => x.key === "malaria_confirmed")
    assert.ok(a, "malaria alert")
    assert.equal(a!.level, "threshold")
    assert.equal(a!.thisWeek, 12)
    assert.equal(a!.threshold, 6)
  })

  it("does not alert on small numbers or normal weeks", () => {
    const rows = []
    for (let w = 1; w <= 8; w += 1) rows.push(dx("CA40.Z", w))
    rows.push(dx("CA40.Z", 0), dx("CA40.Z", 0), dx("CA40.Z", 0))
    assert.equal(buildSurveillance(rows, { now: NOW }).alerts.length, 0)
  })

  it("counts weekly, by district, one case per visit per group, without differentials", () => {
    const rows = [
      dx("1F40.Z", 0, { encounter_id: "same" }), dx("1F40", 0, { encounter_id: "same" }),
      dx("1F40.Z", 1, { district: "Lira" }),
      dx("CA40.Z", 0, { certainty: "differential" }),
      dx("1F40.Z", 0, { district: "" }),
    ]
    const r = buildSurveillance(rows, { now: NOW, weeks: 12 })
    const m = r.series.find((s) => s.key === "malaria_confirmed")!
    assert.equal(m.thisWeek, 2)
    assert.equal(m.lastWeek, 1)
    assert.equal(m.counts.length, 12)
    assert.equal(r.series.find((s) => s.key === "pneumonia"), undefined)
    assert.deepEqual(r.districts.map((d) => d.district).sort(), ["Gulu", "Lira", "Not recorded"])
    assert.equal(r.weeks.at(-1)?.label, "2026-W47")
  })

  it("ignores visits outside the window", () => {
    const r = buildSurveillance([dx("1F40.Z", 30)], { now: NOW, weeks: 12 })
    assert.equal(r.totals.cases, 0)
  })
})
