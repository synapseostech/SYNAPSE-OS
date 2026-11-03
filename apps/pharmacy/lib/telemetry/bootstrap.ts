/**
 * The inline bootstrap that runs before the Vercel insight scripts.
 *
 * It installs the queue stubs the platform's scripts drain, and registers the
 * pageview scrubber before the first pageview can be sent. Whether any of it
 * runs is decided per environment: an environment sends nothing unless its
 * `NEXT_PUBLIC_VERCEL_INSIGHTS` is `"1"`, so a preview deployment cannot
 * silently feed production numbers, and a developer's machine sends nothing.
 */

/** The platform serves these once Web Analytics / Speed Insights are enabled. */
export const ANALYTICS_SCRIPT = "/_vercel/insights/script.js"
export const SPEED_INSIGHTS_SCRIPT = "/_vercel/speed-insights/script.js"

export function telemetryEnabled(value: string | undefined = process.env.NEXT_PUBLIC_VERCEL_INSIGHTS): boolean {
  return value === "1"
}

export function telemetryBootstrap(enabled: boolean): string {
  if (!enabled) return ""
  return `(function () {
  window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };
  window.si = window.si || function () { (window.siq = window.siq || []).push(arguments); };
  function redact(pathname) {
    // Invitation and password-reset links carry their credential in the path,
    // so the token is replaced before the URL leaves the page. Nothing else in
    // the path is touched.
    return pathname.replace(
      /^(\\/invite(?:\\/facility)?|\\/reset-password)\\/[^/]+/,
      "$1/[token]"
    );
  }
  function scrub(event) {
    if (!event || typeof event.url !== "string") return event;
    try {
      var url = new URL(event.url);
      url.search = "";
      url.hash = "";
      url.pathname = redact(url.pathname);
      event.url = url.toString();
    } catch (_) {
      event.url = "";
    }
    return event;
  }
  window.va("beforeSend", scrub);
  window.si("beforeSend", scrub);
})();`
}
