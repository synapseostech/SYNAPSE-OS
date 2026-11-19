"use client";

import { useCallback, useRef, useState } from "react";

export const STEP_UP_REQUIRED_CODE = "MFA_STEP_UP_REQUIRED";

type Pending = { resolve: (ok: boolean) => void };

/**
 * Sensitive actions answer MFA_STEP_UP_REQUIRED until the caller proves their
 * authenticator. `withStepUp(run)` runs the action; on that answer it asks for
 * a 6-digit code, posts it to /api/platform/mfa/step-up and runs the action
 * once more. The server decides — this only spares a second click.
 */
export function useStepUp() {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<Pending | null>(null);

  const ask = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        pending.current = { resolve };
        setCode("");
        setError(null);
        setOpen(true);
      }),
    [],
  );

  function close(ok: boolean) {
    setOpen(false);
    pending.current?.resolve(ok);
    pending.current = null;
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!/^\d{6}$/.test(code.trim())) {
      setError("Enter the 6-digit code from your authenticator.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/platform/mfa/step-up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "That code was not accepted.");
        return;
      }
      close(true);
    } finally {
      setBusy(false);
    }
  }

  const withStepUp = useCallback(
    async <T,>(run: () => Promise<T>): Promise<T> => {
      const first = await run();
      if ((first as { code?: unknown } | null | undefined)?.code !== STEP_UP_REQUIRED_CODE) return first;
      const verified = await ask();
      return verified ? run() : first;
    },
    [ask],
  );

  const dialog = open ? (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="presentation">
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="step-up-title"
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl border border-slate-700 bg-[#0B0B12] p-5 text-slate-100 shadow-2xl"
      >
        <h2 id="step-up-title" className="text-base font-semibold">Confirm it is you</h2>
        <p className="mt-1 text-sm text-slate-400">
          This action needs a fresh code from your authenticator app.
        </p>
        <label className="mt-4 block text-xs font-medium text-slate-400" htmlFor="step-up-code">
          6-digit code
        </label>
        <input
          id="step-up-code"
          autoFocus
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-lg tracking-[0.4em] text-white"
        />
        {error ? <p className="mt-2 text-sm text-red-300" role="alert">{error}</p> : null}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={() => close(false)} className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm">
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-[#E8B84B] px-3 py-1.5 text-sm font-semibold text-black disabled:opacity-50"
          >
            {busy ? "Checking…" : "Confirm"}
          </button>
        </div>
      </form>
    </div>
  ) : null;

  return { withStepUp, dialog };
}

/** fetch() wrapper for route handlers: turns a 403 MFA_STEP_UP_REQUIRED into { code }. */
export type JsonResult = Record<string, unknown> & { ok: boolean; status: number; code?: string; error?: string };

export async function fetchJson(input: string, init?: RequestInit): Promise<JsonResult> {
  const res = await fetch(input, init);
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ...data, ok: res.ok, status: res.status } as JsonResult;
}
