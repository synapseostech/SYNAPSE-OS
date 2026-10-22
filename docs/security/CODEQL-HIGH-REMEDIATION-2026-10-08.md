# CodeQL high-severity remediation — 8 Oct 2026

All 16 open high-severity code-scanning alerts on `main` (`f7479bb`).
None were dismissed or suppressed. Each was fixed in code and covered by a
regression test (`npm run test:security-remediation`).

| Alert | Rule | Location | Exploitability | Fix |
|---|---|---|---|---|
| #25 | js/xss-through-dom | pharmacy portal settings "Test print" | **Exploitable** — tenant-controlled name/address/footer and an unsanitised logo URL were written into a new window's HTML (`javascript:`/`data:text/html` logo, HTML in footer). | `escapeHtml` on every text field; `safeImageSrc` allow-lists raster data URLs, https and same-origin paths. |
| #10 | js/xss-through-dom | pharmacy portal orders print | **Exploitable** — requisition and order print windows interpolated tenant settings, item names, customer name/phone/address and notes raw. | All untrusted interpolations go through `escapeHtml`. Static source guard test. |
| #11 | js/xss-through-dom | tele intake chat | **Exploitable** — user and model messages rendered via `dangerouslySetInnerHTML` with a regex bold transform. | React text nodes with a linear `**bold**` splitter (`renderInlineBold`); payload tests prove `<script>` stays inert. |
| #1 | js/polynomial-redos | lab-edge ASTM parser | Low practical (local bridge input) but unbounded `/\x1c.*$/` on analyzer input. | Linear `indexOf` scan; 1,000,000 char cap; adversarial tests. |
| #2 | js/polynomial-redos | custom-domains `normalizeDomain` | Low practical (platform-admin input) but `replace(/\/.*$/)` was quadratic. | Length cap 2048 + `indexOf` instead of regex. |
| #3 | js/polynomial-redos | TOTP base32 decode | Low practical (short secrets) but `replace(/=+$/)` was quadratic. | Linear trailing-`=` strip; RFC 6238 vector still passes. |
| #4 | js/polynomial-redos | `parseRpcStockError` | Low practical (internal RPC strings) but lazy group was quadratic. | 2000 char cap + `indexOf` parsing. |
| #9 | js/incomplete-multi-character-sanitization | ICD-11 WHO titles | **Exploitable if rendered as HTML** — `/<[^>]+>/` is bypassable by nested tags. | Linear tag strip + entity decode + final angle-bracket removal; terminology preserved. |
| #15 #23 #24 | js/insecure-randomness | demo example picker | Cosmetic only, but the value flowed through component state. | Unbiased CSPRNG `secureRandomPick` (rejection masking, no modulo on random bits). |
| #17 | js/insecure-randomness | legacy vite demo booking id | Legacy, not deployed, but it was an identifier. | `crypto.randomUUID()`. |
| #7 | js/biased-cryptographic-random | Synapse ID body encoding | **Real** — `n % 32` / division biased the last symbols of every patient ID. | 5-bit shift/mask extraction. Proven output-identical to the legacy encoder over 5,000 inputs, so existing IDs stay valid. |
| #8 | js/insufficient-password-hash | lab bridge credential hash | **Real design weakness** — single-round HMAC-SHA-256, no salt. Production had **0** bridge rows, so nothing to migrate. | scrypt (N=16384,r=8,p=1) + per-credential salt + pepper + constant-time verify; lookup by non-secret prefix; legacy 64-hex digests refused with `rotation_required` (401, re-issue). |
| #6 | js/clear-text-logging | pharmacy test setup script | Test script only; printed generated passwords. | Output never contains the password; generated passwords are 24-byte CSPRNG and discarded (use Forgot password). |
| #5 | js/clear-text-logging | MFA probe script | Printed schema-read flags named `*_readable`. | Console prints only PASS/FAIL; full report stays in the evidence file. |

## Residual risk
- XSS fixes cover the three alerted sinks. Other `dangerouslySetInnerHTML` uses
  (theme FOUC script, static layout scripts, demo guide) were reviewed and are
  static strings, not user data; they are not part of these alerts.
- Lab bridge: any bridge issued before this change (none in production) must be
  re-issued; old HMAC digests no longer authenticate.
- The demo and legacy-vite changes are cosmetic/legacy but are fixed honestly
  rather than dismissed.
