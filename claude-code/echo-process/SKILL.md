---
name: echo-process
description: Validate and polish an Echo recording. Use when the user invokes /echo-process <recordingId>, hands you a path to an Echo handoff folder, or asks to polish/validate a recorded walkthrough. Reads ~/Downloads/echo/handoffs/<recordingId>/input.json + screenshots, optionally re-drives the recorded selectors via the /chrome skill, and writes output.json that the extension can apply via "Refresh from Claude".
---

# /echo-process

Process an Echo recording in two passes:
1. **Validate** — re-drive each step's selector against the live app via the `/chrome` skill, capture a fresh screenshot, and report whether the recorded element still exists, is still labeled the same way, or has drifted.
2. **Polish** — rewrite each step's `description` and `notes` to be clearer/tighter, using the codebase in the current working directory as a vocabulary reference if it appears relevant. Suggest a recording title.

The extension owns presenting your output back to the user as accept/reject diffs — never just rewrite the original. Always emit proposals into `output.json`, never modify `input.json` or screenshots.

## Inputs

- `$1` — recording id. Optional. If omitted, list candidate handoff folders under `~/Downloads/echo/handoffs/` (sorted by mtime, newest first) and ask the user which one.
- Handoff folder layout:
  ```
  ~/Downloads/echo/handoffs/<recordingId>/
  ├── input.json
  └── screenshots/
      ├── step-00.png
      ├── step-01.png
      └── ...
  ```

## Schema

`input.json` (read-only — never edit):

```ts
{
  schemaVersion: 1,
  recordingId: string,
  recordingName: string,
  createdAt: number,
  exportedAt: number,
  repoHint?: string,             // optional: a path the user wants you to consider for vocabulary
  steps: Array<{
    id: string,                  // stable; preserve when emitting output
    index: number,
    type: 'click' | 'type' | 'submit' | 'navigate' | 'note',
    description: string,         // current displayed text (what the reader sees today)
    originalDescription: string, // auto-generated baseline before user edits
    notes?: string,              // user-attached prose, may include markdown-lite
    selector?: string,           // CSS selector path the recorder built
    url: string,
    value?: string,
    context?: string,            // nearest section/heading context
    viewport: { width, height },
    screenshotPath?: string,     // relative — e.g. "screenshots/step-03.png"
    timestamp: number,
  }>
}
```

`output.json` (you write this):

```ts
{
  schemaVersion: 1,
  recordingId: string,           // must match input.recordingId
  generatedAt: number,           // Date.now() at write time
  suggestedTitle?: string,       // optional new recording name
  steps: Array<{
    id: string,                  // must match an input step id
    validation?: {
      status: 'pass' | 'fail' | 'unverified',
      validatedAt: number,
      notes?: string,            // short — appears under a colored badge in the editor
    },
    polish?: {
      description?: string,      // proposed replacement for the step's display text
      notes?: string,            // proposed replacement for the step's notes
    },
  }>
}
```

## Workflow

1. **Resolve recording id**, then read `input.json` (Bash `cat`, then parse). Confirm `schemaVersion === 1`. If not, abort with a clear message — schema bumps require updating this skill.

2. **Decide whether to validate.** Validation re-drives the live app, which is destructive-ish. Ask the user once: "Run validation pass? (y/N)". Skip on N. Polish always runs.

3. **Validation pass (if enabled).**
   - For each step that has a `selector` and a `url`, use the `/chrome` skill to navigate to the URL and check whether the selector resolves to a visible element. Don't actually click — just verify the element exists and capture its `textContent` / `aria-label` for drift detection.
   - Mark `pass` when selector resolves and label is unchanged.
   - Mark `fail` when selector doesn't resolve OR the URL 404s.
   - Mark `unverified` for `note`/`navigate`/`type`/`submit` steps the validator can't verify on its own (e.g., multi-step form state). Validation `notes` should explain why.
   - Don't drive the page through interactions — that risks side effects (sending forms, hitting paid APIs).

4. **Polish pass (always).**
   - For each step, propose tighter `description` text. Aim for active voice, scannable, ≤90 chars. Don't repeat what the screenshot already shows.
   - If `cwd` looks like a relevant repo (matches `repoHint` if present, or contains code that names the same UI surfaces in `description`/`url`), use repo vocabulary.
   - Only emit `polish.description` when your proposal is meaningfully different from the current `description`. Same for `notes`.
   - Don't propose changes to `description` for `type` steps that show literal user input — preserve them.

5. **Suggested title.** Read all step descriptions; propose a concise outcome-oriented title (e.g., "Connect Google Calendar to Zoom" not "Recording 2026-05-07 14:23"). Skip when the existing `recordingName` is already specific.

6. **Write `output.json`** to the same handoff folder. Use 2-space JSON indent. Preserve every input step id you considered, omitting `validation` and `polish` for steps with nothing to say.

7. **Tell the user** what you wrote, where, and how many steps got validation / polish proposals. Remind them to click "Refresh from Claude" in the editor.

## Conventions

- Never modify `input.json` or any file under `screenshots/`. They are the user's record of truth.
- Never call any Anthropic API. This skill runs entirely on the user's Claude Code subscription.
- If `/chrome` skill is unavailable, skip validation gracefully (mark all steps `unverified` with note `"chrome skill unavailable"`) and still run polish.
- One handoff folder = one `output.json`. Overwrite previous outputs without prompting.
- Don't propose accepting your own output — the extension's editor handles per-step accept/reject. Your job ends at writing the file.

## Example output stub

```json
{
  "schemaVersion": 1,
  "recordingId": "abc-123",
  "generatedAt": 1746633600000,
  "suggestedTitle": "Connect Google Calendar to Zoom",
  "steps": [
    {
      "id": "s_01",
      "validation": { "status": "pass", "validatedAt": 1746633600000 },
      "polish": {
        "description": "Open Zoom Marketplace and search for Google Calendar"
      }
    },
    {
      "id": "s_02",
      "validation": {
        "status": "fail",
        "validatedAt": 1746633600000,
        "notes": "Selector .install-btn no longer matches — button moved into a modal."
      }
    }
  ]
}
```
