export const dynamic = "force-dynamic";

import { requirePlatformPage } from "@/lib/platform/auth";
import { PlatformNoticeRegion } from "./PlatformNoticeRegion";
import { directoryHref, searchPlatformUsers, SUSPENDED_VERIFICATION_STATUSES } from "@/lib/platform/user-directory";
import { formatDate, platformAdminClient, safeCount, safeRows } from "../_lib/platform-data";
import { UserActions } from "./UserActions";

type VerificationRow = {
  id?: string;
  full_name?: string | null;
  email?: string | null;
  role?: string | null;
  status?: string | null;
  document_type?: string | null;
  registration_body?: string | null;
  registration_number?: string | null;
  created_at?: string | null;
};

function badgeClass(value: string | null | undefined) {
  if (value === "verified" || value === "approved") return "border-green-500/25 bg-green-500/10 text-green-300";
  if (value === "rejected" || value === "suspended") return "border-red-500/25 bg-red-500/10 text-red-300";
  return "border-[#F97316]/25 bg-[#F97316]/10 text-[#F97316]";
}

export default async function PlatformUsersPage({
  searchParams,
}: {
  searchParams?: Promise<{ q?: string; role?: string; status?: string; page?: string; pageSize?: string }>;
}) {
  // /platform/users is mapped to user.read in the control-plane route policy; enforce it here too.
  const admin = await requirePlatformPage("/platform/users");
  const params = (await searchParams) ?? {};

  const [totalUsers, pendingKyc, verifiedUsers, archivedUsers, directory, kycRows] = await Promise.all([
    safeCount("profiles"),
    safeCount("verification_documents", [["status", "pending_review"]]),
    safeCount("profiles", [["verification_status", "verified"]]),
    safeCount("profiles", [["is_deleted", true]]),
    // Search, filters and pagination run in the database query, not over a fixed first page.
    searchPlatformUsers(platformAdminClient() as never, params),
    safeRows<VerificationRow>(
      "verification_documents",
      "id, full_name, email, role, status, document_type, registration_body, registration_number, created_at",
      { filters: [["status", "pending_review"]], orderBy: "created_at", limit: 24 }
    ),
  ]);

  const users = directory.rows;
  const { page, pageCount, total, pageSize } = directory;
  const firstShown = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastShown = Math.min(total, (page - 1) * pageSize + users.length);
  const suspendedSet = new Set<string>(SUSPENDED_VERIFICATION_STATUSES);

  return (
    <div className="space-y-6">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#E8B84B]">Identity Control</p>
          <h1 className="mt-2 text-2xl font-bold">Users + KYC</h1>
          <p className="mt-1 text-sm text-slate-400">Manage platform users, professional verification, suspensions, and access recovery.</p>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ["Total users", totalUsers],
          ["Pending KYC", pendingKyc],
          ["Verified professionals", verifiedUsers],
          ["Archived accounts", archivedUsers],
        ].map(([label, value]) => (
          <article key={String(label)} className="rounded-xl border border-slate-800 bg-[#111117] p-4">
            <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
            <p className="mt-2 text-2xl font-bold text-[#F97316]">{Number(value).toLocaleString()}</p>
          </article>
        ))}
      </section>

      <PlatformNoticeRegion />

      <form className="flex flex-wrap gap-2 rounded-xl border border-slate-800 bg-[#111117] p-4" method="get" role="search" aria-label="Filter users">
        <label className="sr-only" htmlFor="user-q">Search</label>
        <input id="user-q" name="q" defaultValue={params.q ?? ""} placeholder="Name, email, Synapse ID or user ID" className="min-w-[14rem] flex-1 rounded-lg border border-slate-700 bg-[#07070A] px-3 py-2 text-sm" />
        <label className="sr-only" htmlFor="user-role">Role</label>
        <input id="user-role" name="role" defaultValue={params.role ?? ""} placeholder="Role" className="w-40 rounded-lg border border-slate-700 bg-[#07070A] px-3 py-2 text-sm" />
        <label className="sr-only" htmlFor="user-status">Status</label>
        <select id="user-status" name="status" defaultValue={params.status ?? ""} className="rounded-lg border border-slate-700 bg-[#07070A] px-3 py-2 text-sm">
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
          <option value="pending">Invited / pending activation</option>
          <option value="archived">Archived</option>
        </select>
        <button type="submit" className="rounded-lg border border-[#E8B84B]/40 bg-[#E8B84B]/10 px-4 py-2 text-sm text-[#E8B84B]">Filter</button>
      </form>

      <section className="grid gap-4 xl:grid-cols-[1fr_380px]">
        <article className="overflow-hidden rounded-xl border border-slate-800 bg-[#111117]">
          <div className="border-b border-slate-800 p-4">
            <h2 className="text-sm font-semibold">All Users</h2>
            <p className="mt-1 text-xs text-slate-500" aria-live="polite">
              {directory.error
                ? "User search failed. Try again or narrow the filters."
                : `Showing ${firstShown}–${lastShown} of ${total.toLocaleString()} matching profiles.`}
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <caption className="sr-only">Platform users</caption>
              <thead className="bg-[#07070A] text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3" scope="col">Name</th>
                  <th className="px-4 py-3" scope="col">Email</th>
                  <th className="px-4 py-3" scope="col">Role</th>
                  <th className="px-4 py-3" scope="col">Verification</th>
                  <th className="px-4 py-3" scope="col">Joined</th>
                  <th className="px-4 py-3 text-right" scope="col">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {users.map((user) => (
                  <tr key={user.id ?? user.email ?? crypto.randomUUID()}>
                    <td className="px-4 py-3 font-medium text-slate-100">
                      {user.id ? (
                        <a href={`/platform/users/${user.id}`} className="hover:text-[#E8B84B] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#E8B84B]">
                          {user.full_name ?? "Unnamed user"}
                        </a>
                      ) : (
                        user.full_name ?? "Unnamed user"
                      )}
                      {user.synapse_id ? <div className="font-mono text-[10px] text-slate-500">{user.synapse_id}</div> : null}
                    </td>
                    <td className="px-4 py-3 text-slate-400">{user.email ?? "No email"}</td>
                    <td className="px-4 py-3 text-slate-300">{user.role ?? "unknown"}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full border px-2 py-0.5 text-xs ${badgeClass(user.is_deleted || user.account_suspended ? "suspended" : user.verification_status)}`}>
                        {user.is_deleted
                          ? "archived"
                          : user.account_suspended || suspendedSet.has((user.verification_status ?? "").toLowerCase())
                            ? "suspended"
                            : user.email_verified_at
                              ? (user.verification_status ?? "verified")
                              : "pending activation"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-500">{formatDate(user.created_at)}</td>
                    <td className="px-4 py-3">
                      {user.id && user.email ? (
                        <UserActions
                          userId={user.id}
                          email={user.email}
                          role={user.role ?? null}
                          emailVerified={Boolean(user.email_verified_at)}
                          isDeleted={Boolean(user.is_deleted)}
                          verificationStatus={user.account_suspended ? "suspended" : user.verification_status}
                          isSelf={user.id === admin.id}
                        />
                      ) : null}
                    </td>
                  </tr>
                ))}
                {users.length === 0 ? (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-500">No users found.</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
          {pageCount > 1 ? (
            <nav className="flex items-center justify-between border-t border-slate-800 p-4 text-sm" aria-label="User list pages">
              {page > 1 ? (
                <a href={directoryHref(directory.params, { page: page - 1 })} className="text-[#E8B84B] hover:underline">Previous</a>
              ) : (
                <span className="text-slate-600">Previous</span>
              )}
              <span className="text-xs text-slate-500">Page {page} of {pageCount}</span>
              {page < pageCount ? (
                <a href={directoryHref(directory.params, { page: page + 1 })} className="text-[#E8B84B] hover:underline">Next</a>
              ) : (
                <span className="text-slate-600">Next</span>
              )}
            </nav>
          ) : null}
        </article>

        <aside className="rounded-xl border border-slate-800 bg-[#111117] p-4">
          <h2 className="text-sm font-semibold">Pending KYC Queue</h2>
          <p className="mt-1 text-xs text-slate-500">Professional documents awaiting review and AI assessment.</p>
          <div className="mt-4 space-y-3">
            {kycRows.length === 0 ? <p className="rounded-lg border border-slate-800 bg-[#07070A] p-4 text-sm text-slate-500">No pending KYC records.</p> : null}
            {kycRows.map((row) => (
              <article key={row.id ?? row.email ?? crypto.randomUUID()} className="rounded-lg border border-slate-800 bg-[#07070A] p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-slate-100">{row.full_name ?? row.email ?? "Applicant"}</p>
                    <p className="mt-1 text-xs text-slate-500">{row.role ?? "health professional"} · {row.registration_body ?? "body not set"}</p>
                    <p className="mt-1 text-xs text-slate-500">Reg no: {row.registration_number ?? "not supplied"}</p>
                  </div>
                  <span className="rounded-full border border-[#F97316]/25 bg-[#F97316]/10 px-2 py-0.5 text-xs text-[#F97316]">
                    Review
                  </span>
                </div>
              </article>
            ))}
          </div>
        </aside>
      </section>
    </div>
  );
}
