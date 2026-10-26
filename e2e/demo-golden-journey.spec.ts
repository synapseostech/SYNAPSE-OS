import { expect, test } from "playwright/test"
import { attachWriteGuard, readDemoStore, resetDemo } from "./demo-helpers"

test.describe("Demo Golden Journey", () => {
  test("land → reception → nurse → doctor → lab → review → pharmacy → billing → timeline/network", async ({ page }) => {
    test.setTimeout(180_000)
    const guard = attachWriteGuard(page)
    await resetDemo(page)

    await page.getByRole("link", { name: "Start Test Drive" }).click()
    await expect(page.getByRole("heading", { name: "Take a station" })).toBeVisible()
    await expect(page.getByText(/Follow one synthetic patient through the full eight-step care journey/i)).toBeVisible()
    await page.getByRole("heading", { name: "Reception", exact: true }).click()
    await expect(page.getByRole("heading", { name: "Reception" })).toBeVisible()
    await expect(page.getByText("Role mismatch")).toHaveCount(0)
    await expect(page.getByText("SYNTHETIC CHART")).toBeVisible()

    await page.getByRole("button", { name: /Amina Demo/ }).first().click()
    await page.getByRole("button", { name: "OPD" }).click()
    await page.getByLabel("Chief Complaint").fill("Fever and headache for 3 days")
    await page.getByRole("button", { name: "Start Visit & Send to Triage" }).click()
    await expect(page.getByRole("heading", { name: /Visit Started/i })).toBeVisible()
    await page.getByRole("link", { name: "Continue as Nurse" }).click()

    await expect(page.getByRole("heading", { name: "Nurse Station" })).toBeVisible()
    await page.getByLabel("Temperature (°C)").fill("38.2")
    await page.getByLabel("Heart Rate (bpm)").fill("96")
    await page.getByLabel("BP Systolic (mmHg)").fill("110")
    await page.getByLabel("BP Diastolic (mmHg)").fill("70")
    await page.getByLabel("SpO₂ (%)").fill("98")
    await page.getByRole("button", { name: /GREEN/ }).click()
    await page.getByRole("button", { name: "Save Triage & Send to Doctor" }).click()
    await expect(page.getByRole("heading", { name: /Triage Completed/i })).toBeVisible()

    await page.reload()
    await expect(page.getByLabel("Temperature (°C)")).toHaveValue("38.2")

    await page.locator('nav[aria-label="Golden journey stations"]').getByRole("link", { name: /^[✓●]?\s*Doctor$/ }).click()
    await expect(page.getByRole("heading", { name: "Doctor Workspace" })).toBeVisible()
    await expect(page.getByText("38.2°C")).toBeVisible()
    await page.getByRole("button", { name: /History/ }).first().click()
    await page.getByLabel(/History of Present Illness/i).fill("Fever for three days with headache.")
    await page.getByRole("button", { name: /Examination/ }).first().click()
    await page.getByLabel(/General Examination/i).fill("Febrile, alert.")
    await page.getByRole("button", { name: /Assessment/ }).first().click()
    await page.getByLabel(/Clinical Assessment/i).fill("Likely uncomplicated malaria.")
    await page.getByLabel("Add differential diagnosis").fill("Malaria")
    await page.getByRole("button", { name: "Add", exact: true }).click()

    const doctorCopilot = page.getByRole("region", { name: "Synapse AI" })
    await doctorCopilot.getByRole("button", { name: "Synapse AI" }).click()
    await doctorCopilot.getByRole("button", { name: "Generate suggestion" }).click()
    await expect(doctorCopilot.getByText(/Requires qualified human review/i).first()).toBeVisible({ timeout: 15_000 })
    await doctorCopilot.getByRole("button", { name: "Accept" }).click()
    await expect(doctorCopilot.getByText(/ACCEPT ·/)).toBeVisible()

    await page.getByRole("button", { name: /Investigations/ }).first().click()
    await page.getByText("Full Blood Count").click()
    await page.getByText("Malaria Rapid Diagnostic Test").click()
    await page.getByRole("button", { name: /Order 2 Test/ }).click()
    await page.getByRole("link", { name: "Continue as Lab" }).click()

    await expect(page.getByRole("heading", { name: "Lab Worklist" })).toBeVisible()
    await expect(page.getByText("Full Blood Count").first()).toBeVisible()
    await expect(page.getByText("Malaria Rapid Diagnostic Test").first()).toBeVisible()

    const orderNames = ["Full Blood Count", "Malaria Rapid Diagnostic Test"]
    for (const name of orderNames) {
      await page.getByRole("button", { name: new RegExp(name) }).first().click()
      await page.getByRole("button", { name: "Accept Order" }).click()
      await expect(page.getByRole("button", { name: "Collect Specimen" })).toBeVisible()
      await page.getByRole("button", { name: "Collect Specimen" }).click()
      await page.getByLabel("Result Value").fill(name.includes("Malaria") ? "Positive" : "12.5")
      await page.getByRole("button", { name: "Enter Result" }).click()
      await expect(page.getByText(name.includes("Malaria") ? "Positive" : "12.5").first()).toBeVisible()
    }

    const labCopilot = page.getByRole("region", { name: "AI Result Analysis" })
    await labCopilot.getByRole("button", { name: "AI Result Analysis" }).click()
    await labCopilot.getByRole("button", { name: "Generate suggestion" }).click()
    await expect(labCopilot.getByText(/Requires qualified human review/i).first()).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole("button", { name: "Verify Results" })).toHaveCount(0)
    await page.getByRole("link", { name: "Continue as Lab Scientist" }).click()
    await expect(page.getByRole("heading", { name: "Lab Worklist" })).toBeVisible()

    for (const name of orderNames) {
      await page.getByRole("button", { name: new RegExp(name) }).first().click()
      await page.getByRole("button", { name: "Verify Results" }).click()
      await page.getByRole("button", { name: "Verify & Release" }).click()
      await expect(page.getByText("Results Released")).toBeVisible()
    }

    await page.reload()
    await expect(page.getByText("Released").first()).toBeVisible()
    await page.getByRole("link", { name: "Continue as Doctor" }).click()

    await expect(page.getByRole("heading", { name: "Doctor Workspace" })).toBeVisible()
    await expect(page.getByText("NEW LAB RESULT")).toBeVisible()
    await page.getByRole("button", { name: "Review Results" }).click()
    await expect(page.getByText("12.5").first()).toBeVisible()
    await expect(page.getByText("Positive").first()).toBeVisible()
    await page.getByRole("button", { name: "Acknowledge results" }).click()
    await page.getByRole("button", { name: /Prescription/ }).first().click()
    await page.getByRole("button", { name: /Add Medication/ }).click()
    await expect(page.getByText(/Coartem|Artemether/).first()).toBeVisible()
    await page.getByRole("button", { name: /Prescribe 1 Medication/ }).click()
    await page.getByRole("link", { name: "Continue as Pharmacy" }).click()

    await expect(page.getByRole("heading", { name: "Pharmacy" })).toBeVisible()
    await expect(page.getByText(/Coartem|Artemether/).first()).toBeVisible()
    const beforeBatches = (await readDemoStore(page, "batches")) as Array<{ inventoryItemId: string; quantity: number }>
    const beforeQty = beforeBatches.find((row) => row.inventoryItemId === "inv-artemether-lumefantrine")?.quantity ?? 0
    await page.getByRole("button", { name: "Review Prescription" }).click()
    await expect(page.getByText("FEFO").first()).toBeVisible()
    await page.getByRole("button", { name: "Select Batch" }).click()
    await page.getByLabel("Quantity to Dispense").fill("24")
    await page.getByRole("button", { name: "Dispense", exact: true }).click()
    await expect(page.getByRole("heading", { name: /Prescription Dispensed/i })).toBeVisible()
    const afterBatches = (await readDemoStore(page, "batches")) as Array<{ inventoryItemId: string; quantity: number }>
    const afterQty = afterBatches.find((row) => row.inventoryItemId === "inv-artemether-lumefantrine")?.quantity ?? 0
    expect(afterQty).toBe(beforeQty - 24)
    const dispenses = await readDemoStore(page, "dispenses")
    expect(dispenses).toHaveLength(1)

    await page.getByRole("link", { name: "Continue as Billing" }).click()
    await expect(page.getByRole("heading", { name: "Billing" })).toBeVisible()
    await expect(page.getByText("Consultation Fee")).toBeVisible()
    await expect(page.getByText("Laboratory Fees")).toBeVisible()
    await expect(page.getByText("Medication Fees")).toBeVisible()
    await page.getByRole("button", { name: "Generate Invoice" }).click()
    await page.getByRole("button", { name: "Record Payment" }).click()
    await page.getByRole("button", { name: "Close Visit" }).click()
    await expect(page.getByRole("heading", { name: "Journey complete" })).toBeVisible()

    await page.getByRole("link", { name: "View Patient Timeline" }).click()
    await expect(page.getByRole("heading", { name: "Patient Timeline" })).toBeVisible()
    await expect(page.getByText("Demo Hospital").first()).toBeVisible()
    await expect(page.getByText("Demo Lab").first()).toBeVisible()
    await expect(page.getByText("Demo Pharmacy").first()).toBeVisible()

    await page.getByRole("button", { name: "More" }).click()
    await page.getByRole("button", { name: "Network" }).click()
    await expect(page.getByRole("heading", { name: /Network/i })).toBeVisible()
    await expect(page.getByRole("heading", { name: /lab order/i }).first()).toBeVisible()
    await expect(page.getByRole("heading", { name: /prescription/i }).first()).toBeVisible()

    const encounters = await readDemoStore(page, "encounters")
    const payments = await readDemoStore(page, "payments")
    const results = (await readDemoStore(page, "lab_results")) as Array<{ status: string; value: string }>
    expect(encounters).toHaveLength(1)
    expect(payments).toHaveLength(1)
    expect(results.filter((row) => row.status === "released")).toHaveLength(2)
    expect(results.some((row) => row.value === "12.5")).toBeTruthy()
    expect(results.some((row) => row.value === "Positive")).toBeTruthy()
    expect(guard.blocked).toEqual([])
    guard.detach()
  })
})
