# Clinical Intelligence — Wave 1

**Status:** implemented behind feature flag `CLINICAL_INTELLIGENCE_WAVE1` (**default OFF**).  
**Rule:** AI advises; clinician decides. No auto-enable in production.

## What shipped
- Context engine → `PatientContextPacket` (tenant from session only)
- Provider router: OpenRouter (Google free + optional NVIDIA), DeepSeek, mock
- Advise service contract with provenance, ICD-11 validation (local cache), sepsis pathway suggestion
- Safety: forbidden actions blocked; override recording helper
- API: `POST /api/clinical/intelligence/advise` → **503** when flag OFF
- Doctor workspace page reflects flag state
- Expand-safe migration `20261007120000_clinical_intelligence_advice_events.sql` (**not applied to prod**)

## Enable (non-prod / explicit ops only)
```bash
CLINICAL_INTELLIGENCE_WAVE1=true
# optional: CLINICAL_AI_PROVIDER=nvidia
# OPENROUTER_API_KEY=...  and/or DEEPSEEK_API_KEY=...
```

## Non-goals (Wave 1)
- Activating pathways, placing orders, signing diagnoses, certifying death
- Production flag enable without ops approval
- Applying the advice_events migration to production without approval
