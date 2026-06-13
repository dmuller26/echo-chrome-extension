# Echo

**A privacy-first, local-only step recorder for documenting web workflows.**

Echo is a Chrome extension that records your clicks, typing, and navigation on any web page, captures annotated screenshots, and exports a clean, self-contained HTML guide. Think Scribe or Tango — but nothing ever leaves your machine, and an optional AI-polish pass runs on your *own* Claude Code subscription rather than a vendor's servers.

<!-- Demo: replace with a real screenshot/GIF of the editor with a few captured steps. -->
<!-- ![Echo editor](docs/echo-editor.png) -->
> _Demo: a screenshot/GIF of the editor goes here (`docs/echo-editor.png`)._

## Why I built it

Tools like Scribe and Tango are great until you try to document an *internal* system. Then their model breaks down: every screenshot of your private admin panel gets uploaded to their SaaS, the basics sit behind a paywall, the auto-generated step text is generic ("Click on button"), and capture failures are silent. There's no privacy story for the exact use case — internal tooling, customer data, pre-release UI — where documentation matters most.

Echo is the inverse of that, by design:

- **Local-only, zero network egress.** Recordings, screenshots, and exports never leave your device. There is no backend, no account, no upload.
- **Privacy-aware capture.** Password and credit-card fields (`type=password`, `autocomplete=cc-number`, etc.) are never recorded.
- **Self-contained output.** Export is a single HTML file with screenshots inlined as base64 — portable, shareable, no hosting required.
- **Clean Google Docs export.** A separate "Export for Google Docs" produces semantic, unstyled HTML (real `<h1>`/`<h2>`/`<p>`, zero background colors) that imports into Google Docs with native heading and paragraph styles — no stray highlighting or broken spacing. Open it in Drive → *Open with Google Docs*.
- **You own the text.** Steps are auto-described with a real element-labeling heuristic, then fully editable.

It's a deliberate product position — *the documentation tool you can point at your most sensitive screens* — not a feature clone.

## The interesting part: bring-your-own-AI polish

Echo has an optional AI pass that improves recordings **without sending your data anywhere or costing per-call API fees.** Instead of calling a hosted model, the extension writes a handoff folder to disk; you run a Claude Code skill against it locally; the skill writes proposals back; the editor surfaces them as **accept/reject diffs you adjudicate**.

```
Extension  ──exports──▶  ~/Downloads/echo/handoffs/<id>/{input.json, screenshots/}
                                   │
                          you run /echo-process <id>  (Claude Code, local)
                                   │
Editor  ◀──"Refresh from Claude"──  output.json   (per-step polish + validation)
```

Design choices that matter here:

- **The AI never overwrites.** It only *proposes*; every rewrite is an accept/reject diff. The human stays the author.
- **Two passes:** *polish* (tighter, active-voice step text using your repo's vocabulary if relevant) and *validation* (re-drives each recorded selector against the live app to flag steps that have drifted or broken).
- **Versioned contract.** The handoff schema is versioned (`HANDOFF_SCHEMA_VERSION`), enforced on both sides, so the extension and the skill can evolve safely.
- **Zero vendor API calls.** All reasoning runs on your existing Claude Code subscription.

The skill is included in this repo at [`claude-code/echo-process/`](claude-code/echo-process/) — see its README for install.

## Architecture highlights

A few decisions I'm happy with (full context in [`extension/README.md`](extension/README.md)):

- **MV3 with zero `web_accessible_resources`.** The content script is built as a classic IIFE, so Chrome injects it without a module loader — which lets the shipped manifest expose *nothing* to the open web.
- **Race-safe recording.** Step mutations during an active recording route through the service worker's capture chain, so concurrent appends are never lost.
- **Forward-migration on every persisted field.** Older recordings always load; new schema fields default on read.
- **Five surfaces, one source of truth.** Popup, editor, side panel, content script, and service worker stay in sync via a single `STEPS_CHANGED` broadcast over `chrome.storage.local` + IndexedDB.
- **Soft-delete with a trash.** Deleted steps move to a recoverable "recently deleted" section, excluded from export until purged.
- **Live side panel + voice narration.** A side panel shows each step as it's captured; narration (e.g. via a dictation hotkey) attaches to the next click.

**Stack:** Vite + React + TypeScript + Tailwind (popup / editor / side panel), vanilla-TS IIFE content script, MV3 service worker, IndexedDB for blobs, `chrome.storage.local` for live state, `@dnd-kit` for drag-reorder.

## Install & build

See [`extension/README.md`](extension/README.md) for the full build pipeline and Chrome load-unpacked steps. Quick version:

```bash
cd extension
npm install
npm run build      # → load the generated dist/ folder via chrome://extensions (Developer mode)
```

## Status

Personal project, actively used. Local-only by design — there is intentionally no hosted version.

## A note on Scribe / Tango

Echo is an independent, from-scratch project. Scribe and Tango are referenced only for comparison; Echo is not affiliated with, endorsed by, or derived from either product.
