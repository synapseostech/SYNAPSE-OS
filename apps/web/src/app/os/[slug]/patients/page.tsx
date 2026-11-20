import { headers } from "next/headers";
import { resolveTenant } from "../../../../lib/tenant";
import { listHospitalPatients } from "../../../../lib/hospital-os-data";
import Link from "next/link";
import { RegisterPatientForm } from "./RegisterPatientForm";

export default async function PatientsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const { slug } = await params;
  const { q } = await searchParams;
  const hdrs = await headers();
  const subdomain = hdrs.get("x-hospital-subdomain") ?? slug;
  const tenant = await resolveTenant(subdomain);
  if (!tenant) return <div className="p-8 text-red-400">Tenant not found</div>;

  const patients = await listHospitalPatients(tenant.tenantId, q);

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold">Patients</h1>
        <RegisterPatientForm />
      </div>

      <form method="GET" className="mb-6">
        <input
          name="q"
          defaultValue={q}
          placeholder="Name, MRN, phone or NIN"
          className="w-full max-w-md bg-surface border border-edge rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-teal-500"
        />
      </form>

      <div className="clinical-card overflow-hidden shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b border-subtle">
            <tr>
              {["MRN", "Name", "DOB", "Sex", "Registered"].map((h) => (
                <th
                  key={h}
                  className="px-4 py-3 text-left text-xs font-medium text-muted-color uppercase tracking-wider"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-subtle">
            {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
            {((patients as any[]) ?? []).map((p: any) => (
              <tr key={p.id} className="hover:bg-overlay/40">
                <td className="px-4 py-3 font-mono text-xs text-secondary-color">{p.mrn ?? "—"}</td>
                <td className="px-4 py-3">
                  <Link
                    href={`/os/${slug}/patients/${p.id}`}
                    className="text-primary-color hover:text-teal-600 font-medium"
                  >
                    {p.full_name}
                  </Link>
                </td>
                <td className="px-4 py-3 text-secondary-color">{p.dob ?? p.date_of_birth ?? "—"}</td>
                <td className="px-4 py-3 text-secondary-color capitalize">{p.sex ?? "—"}</td>
                <td className="px-4 py-3 text-secondary-color">
                  {p.created_at ? new Date(p.created_at).toLocaleDateString() : "—"}
                </td>
              </tr>
            ))}
            {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
            {((patients as any[]) ?? []).length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-muted-color">
                  No patients found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
