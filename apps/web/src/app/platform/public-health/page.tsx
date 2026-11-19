export const dynamic = "force-dynamic";

import { AlertTriangle, BarChart3, FileDown, MapPinned, Radio } from "lucide-react";
import { requirePlatformPage } from "../../../lib/platform/auth";
import { formatDateTime, safeCount, safeRows } from "../_lib/platform-data";

type DiagnosisRow = {
  code?: string | null;
  icd_code?: string | null;
  description?: string | null;
  diagnosis?: string | null;
  district?: string | null;
  created_at?: string | null;
};

type ExportRow = {
  id?: string;
  export_date?: string | null;
  records_exported?: number | null;
  status?: string | null;
  error_message?: string | null;
};

const NOTIFIABLE = ["Malaria", "Cholera", "Tuberculosis", "HIV", "Hepatitis", "Mpox", "Meningitis", "Ebola"];

export default async function PlatformPublicHealthPage() {
  await requirePlatformPage("/platform/public-health");

  const [diagnoses, dhisRows, surveillanceReports] = await Promise.all([
    safeRows<DiagnosisRow>("diagnoses", "code, icd_code, description, diagnosis, district, created_at", {
      orderBy: "created_at",
      limit: 1000,
    }),
    safeRows<ExportRow>("dhis2_export_log", "id, export_date, records_exported, status, error_message", {
      orderBy: "export_date",
      limit: 10,
    }),
    safeCount("surveillance_reports"),
  ]);

  const districtCounts = new Map<string, number>();
  const diseaseCounts = new Map<string, number>();
  for (const row of diagnoses) {
    const district = row.district || "Unknown district";
    const disease = row.description || row.diagnosis || row.code || row.icd_code || "Uncoded diagnosis";
    districtCounts.set(district, (districtCounts.get(district) ?? 0) + 1);
    diseaseCounts.set(disease, (diseaseCounts.get(disease) ?? 0) + 1);
  }
  const topDistricts = Array.from(districtCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const topDiseases = Array.from(diseaseCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const outbreakRisk = topDiseases.some(([, count]) => count >= 3);

  return (
    <div className="space-y-6">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#E8B84B]">SynapseEPI</p>
          <h1 className="mt-2 text-2xl font-bold">Public Health Surveillance</h1>
          <p className="mt-1 text-sm text-slate-400">Cross-facility disease intelligence, outbreak watch, SDG indicators, and DHIS2 export readiness.</p>
        </div>
        <button type="button" className="rounded-xl bg-[#F97316] px-4 py-2 text-sm font-bold text-[#07070A]">
          Publish bulletin
        </button>
      </section>

      {outbreakRisk ? (
        <section className="rounded-xl border border-red-500/30 bg-red-500/10 p-4">
          <div className="flex gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-300" />
            <div>
              <h2 className="text-sm font-semibold text-red-200">Potential cluster detected</h2>
              <p className="mt-1 text-sm text-red-100/80">
                One or more diagnoses have three or more recent records. Review district distribution and publish a bulletin if clinically confirmed.
              </p>
            </div>
          </div>
        </section>
      ) : null}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ["Diagnosis records scanned", diagnoses.length],
          ["Districts with signals", districtCounts.size],
          ["Surveillance reports", surveillanceReports],
          ["DHIS2 exports logged", dhisRows.length],
        ].map(([label, value]) => (
          <article key={String(label)} className="rounded-xl border border-slate-800 bg-[#111117] p-4">
            <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
            <p className="mt-2 text-2xl font-bold text-[#F97316]">{Number(value).toLocaleString()}</p>
          </article>
        ))}
      </section>

      <section className="grid gap-4 xl:grid-cols-[1fr_360px]">
        <article className="rounded-xl border border-slate-800 bg-[#111117] p-4">
          <div className="mb-4 flex items-center gap-2">
            <MapPinned className="h-4 w-4 text-[#E8B84B]" />
            <h2 className="text-sm font-semibold">Uganda District Heatmap Readiness</h2>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {topDistricts.length === 0 ? <p className="text-sm text-slate-500">No district-coded diagnosis data yet.</p> : null}
            {topDistricts.map(([district, count]) => (
              <div key={district} className="rounded-lg border border-slate-800 bg-[#07070A] p-3">
                <div className="mb-2 flex justify-between text-sm">
                  <span className="font-medium text-slate-200">{district}</span>
                  <span className="text-[#E8B84B]">{count}</span>
                </div>
                <div className="h-2 rounded-full bg-slate-800">
                  <div className="h-2 rounded-full bg-[#F97316]" style={{ width: `${Math.min(100, count * 12)}%` }} />
                </div>
              </div>
            ))}
          </div>
        </article>

        <aside className="space-y-4">
          <section className="rounded-xl border border-slate-800 bg-[#111117] p-4">
            <div className="mb-3 flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-[#E8B84B]" />
              <h2 className="text-sm font-semibold">Top Disease Signals</h2>
            </div>
            <div className="space-y-2">
              {topDiseases.length === 0 ? <p className="text-sm text-slate-500">No diagnosis signals yet.</p> : null}
              {topDiseases.map(([disease, count]) => (
                <div key={disease} className="flex items-center justify-between rounded-lg border border-slate-800 bg-[#07070A] px-3 py-2 text-sm">
                  <span className="truncate text-slate-300">{disease}</span>
                  <span className="font-semibold text-[#F97316]">{count}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-xl border border-slate-800 bg-[#111117] p-4">
            <div className="mb-3 flex items-center gap-2">
              <Radio className="h-4 w-4 text-[#E8B84B]" />
              <h2 className="text-sm font-semibold">Notifiable Disease Watch</h2>
            </div>
            <div className="grid gap-2">
              {NOTIFIABLE.map((disease) => (
                <div key={disease} className="flex items-center justify-between rounded-lg border border-slate-800 bg-[#07070A] px-3 py-2 text-xs">
                  <span className="text-slate-300">{disease}</span>
                  <span className="text-slate-500">watching</span>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-xl border border-slate-800 bg-[#111117] p-4">
            <div className="mb-3 flex items-center gap-2">
              <FileDown className="h-4 w-4 text-[#E8B84B]" />
              <h2 className="text-sm font-semibold">Latest DHIS2 Export</h2>
            </div>
            <p className="text-sm text-slate-300">{dhisRows[0]?.status ?? "No export yet"}</p>
            <p className="mt-1 text-xs text-slate-500">{formatDateTime(dhisRows[0]?.export_date)}</p>
          </section>
        </aside>
      </section>
    </div>
  );
}
