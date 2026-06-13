# Claude Code integration

Echo's optional AI-polish pass runs locally through [Claude Code](https://www.anthropic.com/claude-code), not a hosted API. The extension exports a handoff folder to disk; this skill reads it, proposes per-step polish + validation, and writes `output.json` back; the editor surfaces the proposals as accept/reject diffs.

## Install the skill

Copy the skill into your Claude Code skills directory:

```bash
mkdir -p ~/.claude/skills/echo-process
cp echo-process/SKILL.md ~/.claude/skills/echo-process/SKILL.md
```

## Use it

1. In Echo's editor, export a Claude Code handoff. The extension writes:
   ```
   ~/Downloads/echo/handoffs/<recordingId>/{input.json, screenshots/}
   ```
2. In Claude Code, run `/echo-process <recordingId>` (omit the id to pick from a list).
3. The skill writes `output.json` into the same folder — per-step polish proposals and (optionally) validation results from re-driving each recorded selector against the live app.
4. Back in the editor, click **Refresh from Claude** and accept/reject each proposed change.

## Design notes

- **The skill never modifies `input.json` or the screenshots** — they're the user's record of truth. It only writes `output.json`.
- **It never calls an Anthropic API** — all reasoning runs on your existing Claude Code subscription.
- **The handoff schema is versioned** (`schemaVersion: 1`), enforced on both sides; a bump is a breaking change requiring updates in both the extension and this skill.

See [`echo-process/SKILL.md`](echo-process/SKILL.md) for the full schema and workflow.
