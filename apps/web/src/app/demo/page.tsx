"use client";

import { useState } from "react";
import Link from "next/link";
import { resetDemoPlayground } from "../../lib/demo/browser-repository";
import { demoHref } from "../../lib/demo/paths";
import { applyStationSession, enterStation } from "../../lib/demo/stations";
import { DemoMast } from "../../components/demo/DemoMast";
import { DemoThemeControl } from "../../components/demo/DemoThemeControl";
import { secureRandomPick } from "../../lib/secure-random";

type Differential = {
  condition: string;
  icd11_code: string | null;
  confidence: "high" | "medium" | "low";
  rationale: string;
  key_features: string;
};

type DiagnosisResult = {
  differentials: Differential[];
  suggested_workup: string[];
  red_flags: string[];
  clinical_note: string;
  ucg_reference: string | null;
  ai_model?: string;
  ai_provider?: string;
};

const STEPS = [
  { id: 1, label: "Complaint" },
  { id: 2, label: "Patient" },
  { id: 3, label: "History" },
  { id: 4, label: "Vitals" },
] as const;

const EXAMPLE_CASES = [
  {
    complaint: "3-day fever, headache, and body aches in a child",
    duration: "3 days",
    age: 8,
    sex: "male",
    pregnancy: "not_applicable",
    pastHistory: "Previously healthy; fully immunized for age",
    allergies: "None known",
    medications: "Paracetamol at home",
    riskNotes: "Sibling had fever last week; no recent travel",
    vitals: { temperature_c: 38.9, heart_rate: 104, bp_systolic: 100, bp_diastolic: 65, spo2: 98 },
  },
  {
    complaint: "Persistent cough for 6 weeks with night sweats and weight loss",
    duration: "6 weeks",
    age: 34,
    sex: "female",
    pregnancy: "none",
    pastHistory: "Treated for pneumonia 2 years ago",
    allergies: "None",
    medications: "None",
    riskNotes: "Household contact with chronic cough; lives in Kampala",
    vitals: { temperature_c: 37.8, heart_rate: 88, bp_systolic: 110, bp_diastolic: 72, spo2: 95 },
  },
  {
    complaint: "Severe abdominal pain, vomiting, and watery diarrhoea for 2 days",
    duration: "2 days",
    age: 22,
    sex: "male",
    pregnancy: "not_applicable",
    pastHistory: "No prior abdominal surgery",
    allergies: "NKDA",
    medications: "ORS started yesterday",
    riskNotes: "Drank untreated well water while traveling upcountry",
    vitals: { temperature_c: 38.2, heart_rate: 112, bp_systolic: 95, bp_diastolic: 60, spo2: 99 },
  },
];

const CONFIDENCE_COLOR: { [K in "high" | "medium" | "low"]: { bg: string; text: string; border: string } } = {
  high:   { bg: "rgba(34,197,94,0.10)",  text: "#22C55E", border: "rgba(34,197,94,0.25)"  },
  medium: { bg: "rgba(234,179,8,0.10)",  text: "#EAB308", border: "rgba(234,179,8,0.25)"  },
  low:    { bg: "rgba(160,160,176,0.10)", text: "#A0A0B0", border: "rgba(160,160,176,0.25)" },
};

const DEFAULT_AI_BADGE = { label: "AI Model", color: "#F97316" };
const AI_BADGE: Record<string, { label: string; color: string }> = {
  gemini:     { label: "Gemini 2.0 Flash",         color: "#4285F4" },
  deepseek:   { label: "DeepSeek",                  color: "#7C3AED" },
  openrouter: { label: "OpenRouter (free)",         color: "#F97316" },
};

const VITALS_KEYS = ["temperature_c", "heart_rate", "bp_systolic", "bp_diastolic", "spo2"] as const;
const VITALS_LABELS: Record<string, string> = {
  temperature_c: "Temp (°C)",
  heart_rate: "Heart Rate",
  bp_systolic: "BP Systolic",
  bp_diastolic: "BP Diastolic",
  spo2: "SpO₂ (%)",
};
type VitalKey = typeof VITALS_KEYS[number];

const emptyVitals = (): Record<VitalKey, string> => ({
  temperature_c: "",
  heart_rate: "",
  bp_systolic: "",
  bp_diastolic: "",
  spo2: "",
});

export default function DemoPage() {
  const [step, setStep] = useState(1);
  const [complaint, setComplaint] = useState("");
  const [duration, setDuration] = useState("");
  const [age, setAge] = useState("");
  const [sex, setSex] = useState("unknown");
  const [pregnancy, setPregnancy] = useState("unknown");
  const [pastHistory, setPastHistory] = useState("");
  const [allergies, setAllergies] = useState("");
  const [medications, setMedications] = useState("");
  const [riskNotes, setRiskNotes] = useState("");
  const [vitals, setVitals] = useState<Record<VitalKey, string>>(emptyVitals);
  const [result, setResult] = useState<DiagnosisResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function resetPlayground() {
    await resetDemoPlayground();
    setResult(null);
    setError(null);
    setStep(1);
  }

  const showPregnancy = sex === "female" || sex === "unknown";

  function loadExample() {
    const ex = secureRandomPick(EXAMPLE_CASES);
    if (!ex) return;
    setComplaint(ex.complaint);
    setDuration(ex.duration);
    setAge(String(ex.age));
    setSex(ex.sex);
    setPregnancy(ex.pregnancy);
    setPastHistory(ex.pastHistory);
    setAllergies(ex.allergies);
    setMedications(ex.medications);
    setRiskNotes(ex.riskNotes);
    setVitals({
      temperature_c: String(ex.vitals.temperature_c),
      heart_rate: String(ex.vitals.heart_rate),
      bp_systolic: String(ex.vitals.bp_systolic),
      bp_diastolic: String(ex.vitals.bp_diastolic),
      spo2: String(ex.vitals.spo2),
    });
    setStep(1);
    setResult(null);
    setError(null);
  }

  function canAdvance(): boolean {
    if (step === 1) return complaint.trim().length > 0;
    return true;
  }

  function nextStep() {
    if (!canAdvance()) return;
    setStep((s) => Math.min(4, s + 1));
  }

  function prevStep() {
    setStep((s) => Math.max(1, s - 1));
  }

  async function generate() {
    if (!complaint.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const vitalsPayload = Object.fromEntries(
        VITALS_KEYS.filter((k) => vitals[k]).map((k) => [k, Number(vitals[k])])
      );
      const pregnancyValue =
        sex === "male"
          ? "not_applicable"
          : pregnancy === "unknown"
            ? undefined
            : pregnancy;

      const res = await fetch("/api/demo/differential", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chiefComplaint: complaint,
          age: age ? Number(age) : undefined,
          sex,
          duration: duration.trim() || undefined,
          pregnancy: pregnancyValue,
          pastHistory: pastHistory.trim() || undefined,
          allergies: allergies.trim() || undefined,
          medications: medications.trim() || undefined,
          riskNotes: riskNotes.trim() || undefined,
          vitals: Object.keys(vitalsPayload).length > 0 ? vitalsPayload : undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json() as { error?: string };
        throw new Error(err.error ?? `Server error ${res.status}`);
      }
      setResult(await res.json() as DiagnosisResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  const inp = {
    background: "var(--bg-elevated)",
    border: "2px solid var(--border-edge)",
    color: "var(--text-primary)",
    borderRadius: "6px",
    padding: "10px 14px",
    fontSize: "14px",
    width: "100%",
    outline: "none",
  } as const;

  const labelStyle = { color: "var(--text-muted)" } as const;

  return (
    <main className="min-h-screen">
      <DemoMast>
        <Link
          href="/demo/guide"
          className="font-mono text-xs uppercase tracking-wider"
          style={{ color: "var(--text-secondary)", textDecoration: "none" }}
          onClick={(event) => {
            event.preventDefault()
            window.location.assign(demoHref("guide"))
          }}
        >
          How it works
        </Link>
        <Link
          href="/demo/feedback"
          className="font-mono text-xs uppercase tracking-wider"
          style={{ color: "var(--text-secondary)", textDecoration: "none" }}
          onClick={(event) => {
            event.preventDefault()
            window.location.assign(demoHref("feedback"))
          }}
        >
          Feedback
        </Link>
        <DemoThemeControl />
        <a
          href="https://synapseos.tech/apply"
          className="border px-3 py-1.5 text-xs font-bold"
          style={{ background: "var(--brand-orange)", color: "#07070A", borderColor: "var(--brand-orange)", textDecoration: "none" }}
        >
          Register hospital
        </a>
      </DemoMast>

      <div className="mx-auto max-w-6xl px-4 py-8 sm:py-10">
        <section className="demo-hero mb-8">
          <p className="font-mono text-[10px] font-bold uppercase tracking-[0.28em]" style={{ color: "var(--text-muted)" }}>
            SYNTHETIC TEST DRIVE
          </p>
          <h1 className="font-display mt-2 text-3xl font-bold tracking-tight sm:text-5xl">SYNAPSE Test Drive</h1>
          <p className="mt-3 max-w-2xl text-base" style={{ color: "var(--text-secondary)" }}>
            Run one synthetic patient through Reception, Triage, Doctor, Lab, Pharmacy and Billing.
          </p>
          <p className="mt-2 text-sm font-medium" style={{ color: "var(--brand-orange)" }}>
            DO NOT ENTER REAL PATIENT DATA
          </p>

          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            <a className="demo-btn-primary" href={demoHref("login")}>
              Start Test Drive
            </a>
            <button
              type="button"
              className="demo-btn-secondary"
              onClick={() => {
                applyStationSession("reception")
                window.location.assign(demoHref("reception"))
              }}
            >
              Start Golden Journey
            </button>
            <button type="button" className="demo-btn-secondary" onClick={() => window.location.assign(demoHref("guide"))}>
              View Guide
            </button>
            <a className="demo-btn-secondary" href={demoHref("intelligence")}>
              Open Intelligence Playground
            </a>
            <button type="button" className="demo-btn-secondary" onClick={resetPlayground}>
              Reset Playground
            </button>
          </div>

          <div className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { label: "Demo Hospital", station: "reception" as const },
              { label: "Demo Lab", station: "lab" as const },
              { label: "Demo Pharmacy", station: "pharmacist" as const },
              { label: "Amina Demo", station: "reception" as const },
            ].map((item) => (
              <button key={item.label} type="button" className="demo-card p-3 text-left text-sm font-semibold" onClick={() => enterStation(item.station)}>
                {item.label}
              </button>
            ))}
          </div>

          <ol className="mt-6 grid gap-3 text-sm sm:grid-cols-4">
            <li className="demo-card p-3"><span className="font-mono text-[10px] font-bold" style={{ color: "var(--brand-orange)" }}>01</span><br />Register</li>
            <li className="demo-card p-3"><span className="font-mono text-[10px] font-bold" style={{ color: "var(--brand-orange)" }}>02</span><br />Assess</li>
            <li className="demo-card p-3"><span className="font-mono text-[10px] font-bold" style={{ color: "var(--brand-orange)" }}>03</span><br />Investigate</li>
            <li className="demo-card p-3"><span className="font-mono text-[10px] font-bold" style={{ color: "var(--brand-orange)" }}>04</span><br />Treat & Close</li>
          </ol>
        </section>

        {/* Clinical AI Demo (preserved) */}
        <section className="demo-frame p-6 sm:p-8" aria-labelledby="ai-demo-heading">
          <h2 id="ai-demo-heading" className="font-display font-bold text-2xl mb-2" style={{ color: "var(--text-primary)", letterSpacing: "-0.02em" }}>
            Try Clinical AI
          </h2>
          <p className="text-sm mb-3" style={{ color: "var(--text-secondary)" }}>
            Optional and educational. The Test Drive above does not require AI. For governed kernel output, open the Intelligence playground.
          </p>
          <p className="text-xs mb-6" style={{ color: "var(--brand-orange)" }}>
            Synthetic/de-identified clinical context may be sent to the configured AI provider.
          </p>

          <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-8">
            <div className="space-y-5">
              <nav aria-label="Case steps" className="flex gap-1 sm:gap-2">
                {STEPS.map((s) => {
                  const active = step === s.id;
                  const done = step > s.id;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => {
                        if (s.id < step || (s.id === step + 1 && canAdvance()) || s.id <= step) {
                          if (s.id === 1 || complaint.trim() || s.id <= step) setStep(s.id);
                        }
                      }}
                      className="flex-1 min-w-0 px-1.5 py-2 text-center sm:px-2"
                      style={{
                        background: active ? "rgba(249,115,22,0.12)" : "var(--bg-surface)",
                        border: `2px solid ${active || done ? "var(--brand-orange)" : "var(--demo-ink)"}`,
                        color: active ? "var(--brand-orange)" : done ? "var(--text-primary)" : "var(--text-muted)",
                        cursor: "pointer",
                      }}
                    >
                      <span className="block text-[10px] sm:text-xs font-bold truncate">
                        {s.id}. {s.label}
                      </span>
                    </button>
                  );
                })}
              </nav>

              {step === 1 && (
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-semibold mb-1.5" style={labelStyle}>
                      Chief Complaint *
                    </label>
                    <textarea
                      value={complaint}
                      onChange={(e) => setComplaint(e.target.value)}
                      placeholder="Describe the patient's main complaint..."
                      rows={4}
                      style={{ ...inp, resize: "none" }}
                      onFocus={(e) => (e.target.style.borderColor = "var(--brand-orange)")}
                      onBlur={(e) => (e.target.style.borderColor = "var(--border-edge)")}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold mb-1.5" style={labelStyle}>
                      Symptom duration
                    </label>
                    <input
                      type="text"
                      value={duration}
                      onChange={(e) => setDuration(e.target.value)}
                      placeholder="e.g. 3 days, 2 weeks"
                      style={inp}
                      onFocus={(e) => (e.target.style.borderColor = "var(--brand-orange)")}
                      onBlur={(e) => (e.target.style.borderColor = "var(--border-edge)")}
                    />
                  </div>
                </div>
              )}

              {step === 2 && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold mb-1.5" style={labelStyle}>Age</label>
                      <input
                        type="number"
                        value={age}
                        onChange={(e) => setAge(e.target.value)}
                        placeholder="Years"
                        style={inp}
                        onFocus={(e) => (e.target.style.borderColor = "var(--brand-orange)")}
                        onBlur={(e) => (e.target.style.borderColor = "var(--border-edge)")}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold mb-1.5" style={labelStyle}>Sex</label>
                      <select
                        value={sex}
                        onChange={(e) => {
                          setSex(e.target.value);
                          if (e.target.value === "male") setPregnancy("not_applicable");
                        }}
                        style={inp}
                      >
                        <option value="unknown">Unknown</option>
                        <option value="male">Male</option>
                        <option value="female">Female</option>
                      </select>
                    </div>
                  </div>
                  {showPregnancy && (
                    <div>
                      <label className="block text-xs font-semibold mb-1.5" style={labelStyle}>
                        Pregnancy status
                      </label>
                      <select
                        value={pregnancy}
                        onChange={(e) => setPregnancy(e.target.value)}
                        style={inp}
                      >
                        <option value="unknown">Unknown</option>
                        <option value="none">Not pregnant</option>
                        <option value="pregnant">Pregnant</option>
                        <option value="postpartum">Postpartum</option>
                      </select>
                    </div>
                  )}
                </div>
              )}

              {step === 3 && (
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-semibold mb-1.5" style={labelStyle}>
                      Past medical history
                    </label>
                    <textarea
                      value={pastHistory}
                      onChange={(e) => setPastHistory(e.target.value)}
                      placeholder="Chronic illness, prior admissions, surgeries..."
                      rows={2}
                      style={{ ...inp, resize: "none" }}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold mb-1.5" style={labelStyle}>
                      Allergies
                    </label>
                    <input
                      type="text"
                      value={allergies}
                      onChange={(e) => setAllergies(e.target.value)}
                      placeholder="Drug / food allergies"
                      style={inp}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold mb-1.5" style={labelStyle}>
                      Current medications
                    </label>
                    <input
                      type="text"
                      value={medications}
                      onChange={(e) => setMedications(e.target.value)}
                      placeholder="Ongoing meds or recent antibiotics"
                      style={inp}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold mb-1.5" style={labelStyle}>
                      Other risk notes
                    </label>
                    <textarea
                      value={riskNotes}
                      onChange={(e) => setRiskNotes(e.target.value)}
                      placeholder="Travel, sick contacts, occupation, water source..."
                      rows={2}
                      style={{ ...inp, resize: "none" }}
                    />
                  </div>
                </div>
              )}

              {step === 4 && (
                <div
                  className="grid grid-cols-2 gap-3 p-4 rounded-xl"
                  style={{ background: "var(--bg-surface)", border: "1px solid var(--border-edge)" }}
                >
                  <p className="col-span-2 text-xs" style={{ color: "var(--text-muted)" }}>
                    Vitals are optional — add what you have, then generate.
                  </p>
                  {VITALS_KEYS.map((key) => (
                    <div key={key}>
                      <label className="block text-xs mb-1" style={labelStyle}>
                        {VITALS_LABELS[key]}
                      </label>
                      <input
                        type="number"
                        value={vitals[key]}
                        onChange={(e) => setVitals((v) => ({ ...v, [key]: e.target.value }))}
                        style={{ ...inp, background: "var(--bg-elevated)" }}
                        onFocus={(e) => (e.target.style.borderColor = "var(--brand-orange)")}
                        onBlur={(e) => (e.target.style.borderColor = "var(--border-edge)")}
                      />
                    </div>
                  ))}
                </div>
              )}

              <div className="flex flex-wrap gap-3">
                {step > 1 && (
                  <button
                    type="button"
                    onClick={prevStep}
                    className="px-4 py-3 rounded-xl text-sm font-semibold"
                    style={{ background: "transparent", border: "1px solid var(--border-edge)", color: "var(--text-secondary)", cursor: "pointer" }}
                  >
                    ← Back
                  </button>
                )}
                {step < 4 ? (
                  <button
                    type="button"
                    onClick={nextStep}
                    disabled={!canAdvance()}
                    className="flex-1 min-w-[8rem] font-bold py-3 rounded-xl"
                    style={{
                      background: !canAdvance() ? "rgba(249,115,22,0.4)" : "var(--brand-orange)",
                      color: "#07070A",
                      cursor: !canAdvance() ? "not-allowed" : "pointer",
                      border: "none",
                      fontSize: "15px",
                    }}
                  >
                    Next →
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={generate}
                    disabled={loading || !complaint.trim()}
                    className="flex-1 min-w-[8rem] font-bold py-3 rounded-xl"
                    style={{
                      background: loading || !complaint.trim() ? "rgba(249,115,22,0.4)" : "var(--brand-orange)",
                      color: "#07070A",
                      cursor: loading || !complaint.trim() ? "not-allowed" : "pointer",
                      border: "none",
                      fontSize: "15px",
                    }}
                  >
                    {loading ? "Analysing…" : "Generate Differential →"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={loadExample}
                  className="px-4 py-3 rounded-xl text-sm font-semibold"
                  style={{ background: "transparent", border: "1px solid var(--border-edge)", color: "var(--text-secondary)", cursor: "pointer" }}
                >
                  Load Example
                </button>
              </div>

              {error && (
                <div
                  className="px-4 py-3 rounded-xl text-sm"
                  style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.25)", color: "#EF4444" }}
                >
                  {error}
                </div>
              )}

              <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                For educational purposes only. Not for clinical use without physician oversight.
              </p>
            </div>

            <div>
              {!result && !loading && (
                <div className="h-full flex items-center justify-center text-center" style={{ minHeight: "320px" }}>
                  <div className="space-y-4 px-2">
                    <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="var(--brand-orange)" strokeWidth="1.5" className="mx-auto opacity-50">
                      <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
                    </svg>
                    <p className="text-sm" style={{ color: "var(--text-muted)" }}>
                      Complete the case steps and generate<br />to see AI-assisted differentials.
                    </p>
                  </div>
                </div>
              )}

              {loading && (
                <div className="h-full flex items-center justify-center" style={{ minHeight: "320px" }}>
                  <div className="space-y-4 text-center">
                    <div
                      className="w-10 h-10 rounded-full animate-spin mx-auto"
                      style={{ border: "2px solid var(--border-edge)", borderTopColor: "var(--brand-orange)" }}
                    />
                    <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
                      Consulting clinical AI…
                    </p>
                  </div>
                </div>
              )}

              {result && !loading && (
                <div className="space-y-4">
                  {result.ai_provider && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs" style={{ color: "var(--text-muted)" }}>Powered by</span>
                      <span
                        className="text-xs font-bold px-2 py-0.5 rounded-md"
                        style={{
                          background: `${(AI_BADGE[result.ai_provider] ?? DEFAULT_AI_BADGE).color}18`,
                          color: (AI_BADGE[result.ai_provider] ?? DEFAULT_AI_BADGE).color,
                          border: `1px solid ${(AI_BADGE[result.ai_provider] ?? DEFAULT_AI_BADGE).color}40`,
                        }}
                      >
                        {(AI_BADGE[result.ai_provider] ?? DEFAULT_AI_BADGE).label}
                      </span>
                    </div>
                  )}

                  {result.clinical_note && (
                    <div
                      className="px-4 py-3 rounded-xl"
                      style={{ background: "var(--bg-surface)", border: "1px solid var(--border-orange)" }}
                    >
                      <p className="text-xs font-bold mb-1" style={{ color: "var(--brand-orange)" }}>Clinical Summary</p>
                      <p className="text-sm" style={{ color: "var(--text-primary)", overflowWrap: "break-word" }}>{result.clinical_note}</p>
                    </div>
                  )}

                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: "var(--text-muted)" }}>
                      Differential Diagnoses
                    </h3>
                    <div className="space-y-3">
                      {result.differentials.map((d, i) => {
                        const conf = CONFIDENCE_COLOR[d.confidence] ?? CONFIDENCE_COLOR.low;
                        return (
                          <div
                            key={i}
                            className="p-4 rounded-xl"
                            style={{ background: "var(--bg-surface)", border: "1px solid var(--border-edge)" }}
                          >
                            <div className="flex items-start justify-between gap-2 mb-2">
                              <span className="font-bold text-sm" style={{ color: "var(--text-primary)", overflowWrap: "break-word" }}>{d.condition}</span>
                              <span
                                className="text-xs px-2 py-0.5 rounded-full font-semibold flex-shrink-0"
                                style={{ background: conf.bg, color: conf.text, border: `1px solid ${conf.border}` }}
                              >
                                {d.confidence}
                              </span>
                            </div>
                            {d.icd11_code && (
                              <p className="text-xs font-mono mb-1.5" style={{ color: "var(--brand-gold)" }}>{d.icd11_code}</p>
                            )}
                            <p className="text-sm mb-1" style={{ color: "var(--text-secondary)" }}>{d.rationale}</p>
                            <p className="text-xs" style={{ color: "var(--text-muted)" }}>{d.key_features}</p>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {result.suggested_workup.length > 0 && (
                    <div
                      className="p-4 rounded-xl"
                      style={{ background: "var(--bg-surface)", border: "1px solid var(--border-edge)" }}
                    >
                      <h3 className="text-xs font-bold uppercase tracking-wider mb-2" style={{ color: "var(--text-muted)" }}>
                        Suggested Workup
                      </h3>
                      <ul className="space-y-1">
                        {result.suggested_workup.map((w, i) => (
                          <li key={i} className="flex items-center gap-2 text-sm" style={{ color: "var(--text-secondary)" }}>
                            <span style={{ color: "var(--brand-orange)" }}>•</span>
                            {w}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {result.red_flags.length > 0 && (
                    <div
                      className="p-4 rounded-xl"
                      style={{ background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.25)" }}
                    >
                      <h3 className="text-xs font-bold uppercase tracking-wider mb-2" style={{ color: "#EF4444" }}>
                        ⚠ Red Flags
                      </h3>
                      <ul className="space-y-1">
                        {result.red_flags.map((f, i) => (
                          <li key={i} className="text-sm" style={{ color: "#FCA5A5" }}>• {f}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {result.ucg_reference && (
                    <p className="text-xs italic" style={{ color: "var(--text-muted)" }}>
                      UCG Reference: {result.ucg_reference}
                    </p>
                  )}

                  <div
                    className="p-5 rounded-xl text-center"
                    style={{ background: "var(--bg-surface)", border: "1px solid var(--border-orange)" }}
                  >
                    <p className="font-bold mb-1" style={{ color: "var(--brand-orange)" }}>
                      Ready to deploy in your hospital?
                    </p>
                    <p className="text-sm mb-3" style={{ color: "var(--text-secondary)" }}>
                      Full EHR + AI diagnosis + billing + pharmacy in one platform.
                    </p>
                    <a
                      href="https://synapseos.tech/apply"
                      style={{
                        display: "inline-block",
                        background: "var(--brand-orange)",
                        color: "#07070A",
                        fontWeight: 700,
                        padding: "10px 20px",
                        borderRadius: "10px",
                        textDecoration: "none",
                        fontSize: "14px",
                      }}
                    >
                      Apply for Pilot Access →
                    </a>
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
