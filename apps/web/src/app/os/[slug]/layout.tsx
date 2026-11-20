import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { resolveTenant, userCanAccessTenant } from "../../../lib/tenant";
import { SynapseLogo } from "../../../components/SynapseLogo";
import Link from "next/link";
import { getCurrentUser } from "../../../lib/auth/getCurrentUser";
import { SkipLink, SynapseThemeToggle } from "@synapse/ui";
import { facilityClinicalNav } from "../../../lib/production-navigation";

const CLINICAL_LINKS = (slug: string) =>
  facilityClinicalNav(slug)
    .filter((item) => item.name !== "Dashboard" && item.name !== "Patients" && item.name !== "Import" && item.name !== "Timeline")
    .map((item) => ({ href: item.href, label: item.name }));

export default async function PortalLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  await headers();
  const tenant = await resolveTenant(slug);

  if (!tenant) {
    redirect("https://synapseos.tech?e=unknown-hospital");
  }

  const clinical = CLINICAL_LINKS(slug);
  const user = await getCurrentUser();
  if (!user) redirect(`/os/${encodeURIComponent(slug)}/login?error=authentication-required`);
  if (!(await userCanAccessTenant(user.id, tenant, user.role))) {
    redirect(`/os/${encodeURIComponent(slug)}/login?error=facility-access`);
  }
  const role = user?.role;
  const visibleClinical = clinical.filter(({ label }) => {
    if (!role || role === "hospital_admin" || role === "platform_admin") return true;
    if (role === "receptionist") return ["My Work", "Referrals"].includes(label);
    if (role === "nurse") return ["OPD queue", "Nursing", "Admissions", "My Work"].includes(label);
    if (role === "doctor" || role === "clinical_officer") return ["OPD queue", "Admissions", "Billing", "My Work", "Referrals"].includes(label);
    if (["cashier", "billing_officer", "claims_officer"].includes(role)) return ["Billing", "My Work"].includes(label);
    if (["lab_tech", "lab_scientist", "lab_admin", "lab_supervisor"].includes(role)) return ["Lab worklist", "Analyzer staging", "Instruments", "Analyzer mappings", "Specimens", "Results", "Verification", "My Work"].includes(label);
    if (role === "hospital_admin" || role === "facility_admin") return ["Lab worklist", "Analyzer staging", "Instruments", "Analyzer mappings", "Specimens", "Results", "Verification", "People", "Departments", "Facility admin", "Mortuary", "My Work"].includes(label);
    if (role.startsWith("pharmacy")) return ["Dispense"].includes(label);
    return true;
  });

  return (
    <div data-tenant={tenant.hospitalId} className="min-h-screen bg-base text-primary-color">
      <SkipLink />
      <header className="flex items-center justify-between border-b border-subtle px-6 py-3">
        <div className="flex items-center gap-3">
          <SynapseLogo size="sm" />
          <span className="text-muted-color">|</span>
          <span className="text-sm font-medium text-secondary-color">{tenant.hospitalName}</span>
        </div>
        <nav className="flex flex-wrap items-center gap-4 text-sm">
          <Link href={`/os/${slug}/dashboard`} className="text-muted-color hover:text-primary-color">
            Dashboard
          </Link>
          <Link href={`/os/${slug}/patients`} className="text-muted-color hover:text-primary-color">
            Patients
          </Link>
          {visibleClinical.map(({ href, label }) => (
            <Link key={href} href={href} className="text-muted-color hover:text-primary-color">
              {label}
            </Link>
          ))}
          <Link href={`/os/${slug}/migrate`} className="text-muted-color hover:text-primary-color">
            Import
          </Link>
          <SynapseThemeToggle size="sm" />
        </nav>
      </header>
      <main id="main" tabIndex={-1} className="outline-none">{children}</main>
    </div>
  );
}
