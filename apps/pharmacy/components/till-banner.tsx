"use client"

import { useEffect, useState } from "react"
import Link from "next/link"

type TillSession = { id: string; status: string; expectedCash: number } | null

export function TillBanner() {
  const [session, setSession] = useState<TillSession>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    fetch("/api/admin/till")
      .then((response) => response.json())
      .then((data) => setSession(data.session ?? null))
      .catch(() => setSession(null))
      .finally(() => setLoaded(true))
  }, [])

  if (!loaded) return null

  return (
    <div
      className={`mb-4 rounded-md border px-3 py-2 text-sm ${
        session ? "border-emerald-300 bg-emerald-50 text-emerald-900" : "border-amber-300 bg-amber-50 text-amber-900"
      }`}
      role="status"
    >
      {session ? (
        <>
          Till {session.status.toUpperCase()}.{" "}
          <Link href="/portal/till" className="underline font-medium">
            Close or reconcile
          </Link>
        </>
      ) : (
        <>
          No open till. Sales still complete, but cash will not be reconciled to a session.{" "}
          <Link href="/portal/till" className="underline font-medium">
            Open till
          </Link>
        </>
      )}
    </div>
  )
}
