# WebRTC → PSTN bridge (Phase 8 — disabled by default)

PRD Flow C option B connects a browser session to a phone helpline
(iCall/AASRA) through FreeSWITCH + JsSIP, so the user's browser becomes the
phone and their real number never exists anywhere in the call path.

**This feature ships disabled and is not part of the default deployment.**
Two hard reasons (ROADMAP risk R1):

1. **Cost.** SIP-trunk termination to the PSTN is never free. Bundling a
   trunk would break the project's zero-cost guarantee; each operator must
   bring their own.
2. **Legality.** In India, unrestricted VoIP→PSTN termination is a licensed
   activity (interconnection rules under DoT telecom licensing). Operating
   an unlicensed bridge to Indian phone numbers could be unlawful. Anyone
   enabling this must verify their trunk provider's licensing and their own
   obligations first. Similar rules exist in other jurisdictions.

The default build gives users the same outcomes without a bridge: tap-to-call
`tel:` links for iCall/Vandrevala/AASRA (the phone app dials — free, legal),
anonymous Jitsi video with volunteers, and 7 Cups.

## For self-hosters who have a compliant trunk

Planned integration shape (contributions welcome):

- FreeSWITCH container (`infra/`) with `mod_verto`/`mod_sofia`, WSS on 7443.
- `TelephonyAdapter` in `packages/adapters` wrapping JsSIP session setup;
  the PWA gains a "call through browser" option gated by
  `PSTN_BRIDGE_ENABLED=true`.
- Caller ID: the platform's VoIP number. No recording. No CDR content
  beyond an aggregate call-connected event. 30-second no-answer timeout
  surfaces the fallback numbers (PRD edge case).

Until then, the fallback behaviour above is the supported path.
