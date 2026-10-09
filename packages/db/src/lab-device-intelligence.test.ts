import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  assertDeviceValidationTransition,
  connectedIsNotClinicallyTrusted,
  deriveDeviceOperationalHealth,
  detectUnitMismatch,
  deviceMayIngest,
  evaluateCriticalValue,
  evaluateDeltaCheck,
  hashBridgeSecret,
  isLegacyBridgeHash,
  issueBridgeSecret,
  isRejectedBridgeCredentialFormat,
  verifyBridgeSecret,
  mappingCoverage,
} from "./lab-device-intelligence.ts"

describe("lab device intelligence", () => {
  it("treats CONNECTED as physically present, not clinically trusted", () => {
    assert.equal(connectedIsNotClinicallyTrusted("CONNECTED"), true)
    assert.equal(deviceMayIngest({ validationStatus: "CONNECTED", active: false }), false)
    assert.equal(deviceMayIngest({ validationStatus: "CONNECTED", active: true }), false)
    assert.equal(deviceMayIngest({ validationStatus: "VALIDATION", active: false }), true)
    assert.equal(deviceMayIngest({ validationStatus: "ACTIVE", active: true }), true)
    assert.equal(deviceMayIngest({ validationStatus: "SUSPENDED", active: true }), false)
    assert.doesNotThrow(() => assertDeviceValidationTransition("CONFIGURED", "CONNECTED"))
    assert.throws(() => assertDeviceValidationTransition("CONFIGURED", "ACTIVE"), /DEVICE_INVALID_TRANSITION/)
  })

  it("derives health from timestamps and queue state rather than static labels", () => {
    const now = Date.parse("2026-09-20T20:00:00.000Z")
    assert.equal(
      deriveDeviceOperationalHealth({
        validationStatus: "ACTIVE",
        lastSeenAt: "2026-09-20T19:59:30.000Z",
        now,
      }),
      "Active",
    )
    assert.equal(
      deriveDeviceOperationalHealth({
        validationStatus: "ACTIVE",
        lastSeenAt: "2026-09-20T18:00:00.000Z",
        queueDepth: 4,
        failedCount: 2,
        now,
      }),
      "Queueing offline",
    )
    assert.equal(
      deriveDeviceOperationalHealth({
        validationStatus: "VALIDATION",
        lastSeenAt: "2026-09-20T19:59:50.000Z",
        now,
      }),
      "Validation mode",
    )
  })

  it("computes mapping coverage only from observed counts", () => {
    assert.deepEqual(mappingCoverage(3, 1), { mapped: 3, unmapped: 1, percent: 75 })
    assert.deepEqual(mappingCoverage(0, 0), { mapped: 0, unmapped: 0, percent: 0 })
  })

  it("flags critical values deterministically and does not convert mismatched units", () => {
    assert.equal(evaluateCriticalValue({ loincCode: "718-7", value: "5.0", unit: "g/dL" }).critical, true)
    assert.equal(evaluateCriticalValue({ loincCode: "718-7", value: "13.4", unit: "g/dL" }).critical, false)
    assert.equal(evaluateCriticalValue({ loincCode: "718-7", value: "5.0", unit: "mmol/L" }).reason, "unit_mismatch_review_required")
    assert.equal(detectUnitMismatch("mg/dL", "mmol/L"), true)
    assert.equal(evaluateDeltaCheck({ current: 18, previous: 10, percentLimit: 50 }).reviewRequired, true)
  })

  it("issues hashed bridge secrets without storing the presented key as the hash input identity", () => {
    const issued = issueBridgeSecret("lab-bridge-test-hmac")
    assert.match(issued.secret, /^lbk_/)
    assert.match(issued.hash, /^scrypt1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/)
    assert.notEqual(issued.hash, issued.secret)
    assert.ok(!issued.hash.includes(issued.secret))
    assert.throws(() => hashBridgeSecret(issued.secret), /LAB_BRIDGE_HASH_UNAVAILABLE/)
    assert.equal(isRejectedBridgeCredentialFormat(`ref:${issued.prefix}`), true)
    assert.equal(isRejectedBridgeCredentialFormat(issued.prefix), false)
  })

  it("stores bridge tokens with salted scrypt and verifies in constant time (CodeQL #8)", async () => {
    const pepper = "lab-bridge-test-hmac"
    const issued = issueBridgeSecret(pepper)
    assert.equal(await verifyBridgeSecret(issued.secret, issued.hash, pepper), true)
    assert.equal(await verifyBridgeSecret(issued.secret + "x", issued.hash, pepper), false)
    assert.equal(await verifyBridgeSecret(issued.secret, issued.hash, "other-pepper"), false)
    // Per-credential salt: hashing the same token twice yields different records.
    assert.notEqual(hashBridgeSecret(issued.secret, pepper), hashBridgeSecret(issued.secret, pepper))
    assert.equal(await verifyBridgeSecret(issued.secret, "scrypt1$bad", pepper), false)
    assert.equal(await verifyBridgeSecret(issued.secret, null, pepper), false)
    await assert.rejects(() => verifyBridgeSecret(issued.secret, issued.hash, ""), /LAB_BRIDGE_HASH_UNAVAILABLE/)
  })

  it("flags legacy single-round digests for rotation instead of trusting them", () => {
    assert.equal(isLegacyBridgeHash("a".repeat(64)), true)
    assert.equal(isLegacyBridgeHash(issueBridgeSecret("p").hash), false)
    assert.equal(isLegacyBridgeHash(null), false)
  })
})

