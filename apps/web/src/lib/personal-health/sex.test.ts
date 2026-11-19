import { describe, expect, it } from "vitest"
import { normaliseSignupSex } from "./sex"

describe("normaliseSignupSex", () => {
  it("maps sex at birth onto the patient_profiles.sex constraint", () => {
    expect(normaliseSignupSex({ sex: "female" }).clinicalSex).toBe("female")
    expect(normaliseSignupSex({ sex: "male" }).clinicalSex).toBe("male")
    expect(normaliseSignupSex({ sex: "intersex" }).clinicalSex).toBe("other")
  })

  it("stores prefer-not-to-say as null instead of failing the check constraint", () => {
    expect(normaliseSignupSex({ sex: "undisclosed" }).clinicalSex).toBeNull()
    expect(normaliseSignupSex({ gender: "undisclosed" }).clinicalSex).toBeNull()
    expect(normaliseSignupSex({}).clinicalSex).toBeNull()
    expect(normaliseSignupSex({ sex: "robot" }).clinicalSex).toBeNull()
    expect(normaliseSignupSex({ sex: "constructor" }).clinicalSex).toBeNull()
  })

  it("accepts the legacy `gender` field from older app builds", () => {
    expect(normaliseSignupSex({ gender: "Female" }).clinicalSex).toBe("female")
  })

  it("keeps gender identity separate and optional", () => {
    expect(normaliseSignupSex({ sex: "male", gender_identity: " Non-binary " })).toEqual({
      clinicalSex: "male",
      genderIdentity: "Non-binary",
    })
    expect(normaliseSignupSex({ sex: "male" }).genderIdentity).toBeNull()
  })
})
