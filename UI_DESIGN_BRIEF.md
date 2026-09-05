# Open Ledger — UI & Motion Design Brief (for the person building the interface)

This isn't a spec you implement literally — it's the taste and judgment calls a designer would make for you, written out so you don't have to guess. `DESIGN.md` §9 tells you *what* every screen contains; the mockup artifact (link in README) shows a static starting point; this file is about *how it moves and feels*, and what will quietly kill the demo if it's wrong.

---

## The one feeling to aim for

**"A system you'd trust with money, that happens to be alive."** Not playful, not corporate-dead either. Every animation should read as *evidence of real work happening*, not decoration. If a judge can't tell whether a motion means something changed, or is just there to look busy, it's wrong.

## What would kill the presentation (read this first, it's the most important section)

- **Anything that looks like it came out of an AI image generator's idea of "fintech."** No purple-to-blue gradients. No glassmorphism blur panels. No floating 3D coins or abstract particle fields. No emoji as icons or section markers. If you'd see it on a generic SaaS landing page template, it's the wrong choice here — this product's credibility comes from looking like it was built by people who understand accounting, not people who prompted a design tool.
- **Motion that isn't tied to a real state change.** A shimmer/pulse "loading" effect that runs forever, a hover-bounce on every card, confetti on approval — all read as filler. Every animation in this product should be a direct, honest signal: something in the ledger actually changed, and the motion is how you saw it happen.
- **Slowness.** If clicking a node takes longer than ~150ms to respond, or a page transition takes longer than ~300ms, it reads as sluggish, not premium. Real-time data (the swimlane) should feel instant because it *is* instant — SSE events arriving and rendering, not a fake typing-effect delay bolted on for drama.
- **Decoration that isn't state.** Color is the one thing this product must spend with total discipline: if green/yellow/red/blue ever appear anywhere except a status chip, confidence indicator, or the one accent CTA, it's already reading as noise, not signal.
- **A UI that hides the thing that makes this project different.** If the swimlane, the "ask why" popover, and the audit-seal are buried behind extra clicks or under-designed compared to the rest of the screen, you've hidden the actual USP under generic CRUD-app chrome. These three things should look *more* considered than everything else on the page, not less.

## Design system to build from (don't reinvent — this was already researched and mocked up)

Palette: warm-neutral paper background, near-black ink text, one accent (deep ledger-navy), semantic status colors kept strictly separate from the accent (green=clean, amber=review, red=blocked/fraud, blue=in-progress — never decorative). Typography: a display serif (Fraunces) used *sparingly*, a plain enterprise sans (IBM Plex Sans) for everything operational, a mono (IBM Plex Mono) for every number, hash, and code — tabular figures always, so digits line up in columns. Quiet chrome: thin borders, soft shadows used only to lift the one thing that needs lifting, never stamped on every card equally. Full mockup is published — treat it as the floor, not the ceiling; you have real license to push the motion and polish further than a static HTML mockup ever could.

## Per-screen: what triggers what, and how it should feel

**Dashboard.** The backlog headline number ("N invoices need you") should *count* into place on load (a quick 400-600ms number tween, not a slot-machine spin) — it's the one number that deserves a moment. Stat tiles fade/rise in with a very slight, staggered delay (40-60ms apart) so the eye reads them in order, not all at once. The "chain verified ✓" badge should have a subtle, slow pulse *only* while a verification check is actually running, then settle to a static, confident state — never a permanent idle animation.

**Invoice queue.** Rows should not animate on load beyond a simple fade — this is a working list, not a hero section. When an invoice's status changes live (e.g., during a demo run), that specific row should highlight briefly (a soft background flash, ~600ms, easing out) so a judge watching the screen catches the change without needing to be told where to look.

**Invoice detail — the swimlane (this is the centerpiece, spend your best effort here).** Each agent node should animate in sequence as its real SSE event arrives — not a pre-baked animation timeline. A node's transition from "pending" to "active" to "done" should feel like a *relay handoff*: a small directional pulse or line-draw from the previous node to the next as work passes along, timed to the actual event, never faster than the real latency (don't fake speed — if the real tool call took 1.2s, don't compress it to 200ms just to look snappy; the real pacing IS the credibility). Confidence numbers should count up/settle rather than snap to a final value. When a node reaches a conclusion, its reason-code chip should appear with a small, definite motion (a short scale-in, ~150ms, no bounce) — bounce reads as playful, this product should read as certain.

**The "ask why" popover.** This should feel like a genuine, quick conversation, not a modal dialog. A soft slide-up-and-fade from the node it's anchored to (not a centered modal that disconnects it from context), an answer that streams in token-by-token if your API supports it (matches how the underlying model actually generates it — don't fake a typewriter effect over an already-complete string, that reads as theater once anyone notices).

**The audit-seal moment.** This is worth real craft: when a decision's hash gets computed and the row becomes "sealed," give it a single, deliberate visual beat — the lock/seal icon resolving into place (a short draw-on or scale-settle, ~250-350ms), never a spinning/looping seal icon. This one moment is doing a lot of the "not a black box" storytelling — it should look like something *closing*, permanently, not decorating.

**Reviewer action (approve/reject/contest).** Give real, immediate feedback on click — a button press-state (scale down 2-3%, instant) before anything async happens, so the interface never feels laggy even if the network call takes a moment. On success, the whole card should exit distinctly differently depending on the action: approve = a clean dismiss (fade + slight upward exit, "handled"); contest = the card stays, but visibly gains a "reconsidering" state (not a dismiss) — the two outcomes should never look the same.

**Ecosystem map.** This is the one screen that can have a touch more personality — a slow, ambient line-draw animation on first view (the connecting lines drawing themselves in over ~800ms) is appropriate here specifically because it's a diagram, not an operational screen. Don't repeat this technique anywhere else in the product or it stops feeling special.

## Apple-level principles, translated to this product

- **Restraint is the craft.** The best version of this UI has *fewer* animated elements than your first instinct, each one doing real communicative work. Cut anything you can't justify in one sentence ("this motion tells the user X").
- **One hero moment per screen, not zero, not five.** The swimlane's live handoff is the hero of the detail screen. The counting headline number is the hero of the dashboard. Everything else should be quiet by comparison.
- **Physically plausible easing, always.** Use `cubic-bezier(0.16, 1, 0.3, 1)` (a nice "ease-out-expo" feel) for things entering/settling, a snappier ease-in for things leaving. Never linear easing on anything meant to feel alive — linear reads as robotic, which is the opposite of the "feels alive" goal even though the subject is literally an AI.
- **Every interactive element must look interactive before it's touched** — real hover/focus states, a visible pressed state, a clear disabled state. A button that looks the same in every state is a common tell of an unfinished build.
- **Respect `prefers-reduced-motion`** — swap animated transitions for instant or near-instant state changes for anyone with that preference set; don't skip this, it's a real accessibility requirement and cheap to honor.
- **Never animate for the sake of the demo video and leave the real usage worse for it.** If a judge actually clicks around after watching the video, everything should hold up at the same quality, not just the choreographed path.

## A note on originality

This product's whole pitch is "not a black box, genuinely accountable." The UI should *look* like that promise, not like a generic AI-agent dashboard template. If you find yourself reaching for the same visual moves you'd use on any other hackathon project — rounded-corner cards with a soft shadow on literally everything, a hero gradient, an emoji per feature — stop and ask whether *this specific product*, about ledgers, audits, and accountability, would actually look that way. It probably wouldn't.
