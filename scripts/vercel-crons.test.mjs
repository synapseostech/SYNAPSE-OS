// The synapse-os Vercel project builds from the repo root (Root Directory "."), so only the ROOT
// vercel.json is read; crons declared in apps/web/vercel.json are never scheduled.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const root = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"))
const web = JSON.parse(readFileSync(new URL("../apps/web/vercel.json", import.meta.url), "utf8"))
const rootCrons = root.crons ?? []
const webCrons = web.crons ?? []

test("root vercel.json schedules the billing sweep", () => {
  const sweep = rootCrons.find((c) => c.path === "/api/cron/billing-sweep")
  assert.ok(sweep, "billing-sweep cron must be declared in the root vercel.json")
  assert.equal(sweep.schedule, "15 21 * * *")
})

test("root vercel.json schedules the dhis2 export", () => {
  const dhis2 = rootCrons.find((c) => c.path === "/api/cron/dhis2-export")
  assert.ok(dhis2, "dhis2-export cron must be declared in the root vercel.json")
  assert.equal(dhis2.schedule, "0 23 * * *")
})

test("apps/web/vercel.json declares no crons (they are ignored by Vercel when root directory is '.')", () => {
  assert.equal(webCrons.length, 0, "apps/web/vercel.json must not declare crons; they are never scheduled")
})

test("every root cron runs at most once a day (Hobby plan limit) and targets an existing route", () => {
  for (const c of rootCrons) {
    const [min, hour] = c.schedule.split(/\s+/)
    assert.match(min, /^\d+$/, `${c.path}: minute must be fixed`)
    assert.match(hour, /^\d+$/, `${c.path}: hour must be fixed`)
    const route = new URL(`../apps/web/src/app${c.path}/route.ts`, import.meta.url)
    assert.doesNotThrow(() => readFileSync(route), `${c.path} route exists`)
  }
})
