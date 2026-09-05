# Open Ledger — Citations

Backing the specific factual claims made across the spec set, so a skeptical judge or teammate doesn't have to take them on faith. Split by verification status — this distinction matters, because checking these turned up one real error (below), which is exactly why the distinction is here instead of one undifferentiated list.

## Directly fetched and read by me, in this conversation (highest confidence)

- **Hackathon rules & judging rubric**: [syndicate-by-maximor.devpost.com](https://syndicate-by-maximor.devpost.com/) and the [Syndicate Notion page](https://maaztwts.notion.site/Syndicate-3cc32902e4a38075bfa9f03149ef150d) — fetched directly, multiple times, as rules were clarified over the build.
- **Maximor's own product messaging** ("Audit-Ready Agents™," ~90-98% straight-through, "100% of entries with a complete audit trail," insist-on-human-oversight survey): [maximor.ai](https://www.maximor.ai/) — fetched directly.
- **Agent Orchestrator's actual architecture** (Go daemon, git-worktree-per-session, PR/CI tracking, no finance-domain runtime, no MCP support): [github.com/Untrivial-ai/agent-orchestrator](https://github.com/Untrivial-ai/agent-orchestrator) and its `docs/architecture.md` — fetched directly; also independently confirmed live against this machine's actual running daemon (`ao doctor`, `ao session ls`, direct REST calls to `127.0.0.1:3001`), not just documentation.
- **OpenAI Responses API tool-calling syntax** (the exact JSON shapes in ENGINE.md §3/ALGORITHMS.md §4): [developers.openai.com/api/docs/guides/function-calling](https://developers.openai.com/api/docs/guides/function-calling) — fetched directly, current as of this build.
- **Invoice processing time**: Ardent Partners' State of ePayables 2025, via [Medius's summary](https://www.medius.com/resources/guides-reports/ardent-partners-state-of-epayables/) — fetched directly: *"Businesses using advanced automation reduced invoice processing times to 2.9 days, compared to the industry average of 8.2 days."* This is the real, verified version of the pain-point stat — see the correction note below.

## A correction, made during final review — say this plainly, don't hide it

An earlier draft of this project's pitch (in `AUDIT_FINAL.md`) cited **"Ardent Partners' 18.4% invoice exception rate"** as sourced evidence for the pain point. On direct verification, that specific figure does not appear anywhere in Ardent Partners' actual published State of ePayables 2025 material — a targeted search and a direct fetch of the closest available summary found no such number. It's been removed from every document. The real, verified claim is the 8.2-days-vs-2.9-days processing-time figure above, which still supports the same pain-point argument (slow, manual AP processing is a real, measured problem; automation measurably helps) without asserting a number that doesn't check out. **If asked in a demo Q&A "where does the 18.4% come from," the honest answer is: it doesn't, that was a research error, caught and corrected — here's the real figure instead.** That's a better answer than being caught with an uncheckable one.

## Reported by research subagents during this project's design phase, not independently re-fetched by me since (treat specific numbers with appropriate caution — one subagent-sourced figure was already found wrong, above)

- ECOA/Regulation B, 12 CFR § 1002.9 (specific-reasons requirement for adverse decisions): [law.cornell.edu/cfr/text/12/1002.9](https://www.law.cornell.edu/cfr/text/12/1002.9)
- CFPB Circular 2022-03 ("black box" not a valid defense for withholding adverse-action reasons): [federalregister.gov/documents/2022/06/14/2022-12729](https://www.federalregister.gov/documents/2022/06/14/2022-12729/consumer-financial-protection-circular-2022-03-adverse-action-notification-requirements-in)
- Brex's disclosed multi-agent "Agent Mesh": [venturebeat.com — Brex bets on less orchestration](https://venturebeat.com/orchestration/brex-bets-on-less-orchestration-as-it-builds-an-agent-mesh-for-autonomous)
- BlackLine's "Agentic Financial Operations" / Verity launch: [blackline.com press release](https://www.blackline.com/about/press-releases/2026/blackline-unveils-agentic-financial-operations-to-close-ais-governance-and-trust-gap/)
- Fieldguide's disclosed multi-agent PBC pipeline + funding: [Yahoo Finance](https://finance.yahoo.com/news/fieldguide-raises-75m-series-c-140000356.html), [KPMG press release](https://kpmg.com/us/en/media/news/kpmg-fieldguide-reimagine-ai-enabled-assurance.html)
- Boomi hackathon precedent, "Invoice Assistant" (near-identical shape to this project, won a real 2025 hackathon): [Bits In Glass](https://bitsinglass.com/from-inbox-to-paid-how-an-ai-agent-is-quietly-transforming-accounts-payable/)
- Alfrink et al., "Contestable AI by Design" (the academic framework behind this project's interrogability/contest mechanic): [research.tudelft.nl](https://research.tudelft.nl/en/publications/contestable-ai-by-design-towards-a-framework/)

**Before quoting any specific number from this second list in the demo video or a live Q&A, do a quick independent check first** — the same discipline that caught the 18.4% error should be applied here too, not just once.
