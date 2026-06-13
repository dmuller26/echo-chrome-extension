# Echo — Chrome Extension

Records steps on web pages and exports a step-by-step HTML guide.

## Develop

```bash
npm install
npm run build       # one-shot production build (described below)
```

Then in Chrome:

1. Go to `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select the generated `dist/` folder.

### Build pipeline

`npm run build` runs three steps in sequence:

1. **Main bundle** (`vite build`) — popup, editor, service worker, manifest, icons via `@crxjs/vite-plugin`.
2. **Content script** (`vite build --config vite.content.config.ts`) — bundles `src/content/recorder.ts` as a single classic **IIFE** (`dist/content-script.js`), inlining all imports.
3. **Manifest patch** (`scripts/patch-manifest.mjs`) — injects the `content_scripts` entry pointing at the IIFE and strips any leftover `web_accessible_resources` block.

The IIFE format is intentional: it lets Chrome inject the content script as a classic script with no module loader, eliminating the `web_accessible_resources` entry that would otherwise be required for ES-module content scripts under MV3. The shipped manifest exposes **zero** resources to the open web.

### Dev mode caveat

`npm run dev` runs the @crxjs HMR-aware dev server for the popup / editor / service worker, but **does not rebuild the IIFE content script automatically**. To iterate on the recorder, run in a second terminal:

```bash
npm run dev:content    # vite build --watch for content-script.js
```

This rebuilds `dist/content-script.js` on every save. After the first run you may need to click the reload icon on the extension card in `chrome://extensions`.

## Use

1. Click the Echo toolbar icon → **Start recording** (or press the keyboard shortcut — see below).
2. Click and type on the page. Each click and form change becomes a step with a screenshot. While recording, the toolbar icon shows a red badge with the step count.
3. Click the icon again → **Stop recording** (or press the shortcut again).
4. Click the recording in the list to open the editor — reorder, edit text, delete steps.
5. **Export as HTML** → downloads a self-contained `.html` file with screenshots inlined.

## Keyboard shortcut

The extension exposes a `Toggle recording` command. Default suggestion is `⌘.` (macOS) / `Ctrl+.` (Windows/Linux), but Chrome won't auto-bind a shortcut that conflicts with another extension's binding.

To set it up:

1. Open `chrome://extensions/shortcuts`.
2. Find **Echo**.
3. If the **Activate the extension** row is bound to `⌘.`, clear it (otherwise Chrome will refuse to bind the same shortcut to two commands).
4. Set **Start or stop a recording** to `⌘.`.

Pressing the shortcut now toggles a recording on the active tab without needing to open the popup. The toolbar badge confirms — red number means recording.

## Recently deleted steps

Deleting a step from the editor doesn't permanently remove it. The step moves to a **Recently deleted** section at the bottom of the editor, where you can:

- **Restore** — appends the step to the end of your guide (drag-reorder back into place if needed).
- **Delete forever** — permanently removes the step and its screenshot from IndexedDB. Asks for confirmation.

Soft-deleted steps are excluded from the HTML export until permanently deleted. They persist across editor sessions.

## Side panel — live recording dashboard

Starting a recording (via the popup, the keyboard shortcut, or the side panel itself) auto-opens a Chrome side panel that shows every step the moment it's captured: thumbnail, description, attached notes, and a live timer. Soft-deleted steps don't appear.

### Voice narration via Wispr Flow

The side panel includes a persistent **"Narration for next step"** textarea pinned to the bottom. The pre-narration model:

1. Click the textarea once so it has OS focus
2. Press your Wispr Flow hotkey, dictate (e.g., *"Now we click Settings to open account preferences"*), release
3. Text appears in the textarea — status pill flashes "Pending"
4. Click the page target — the SW attaches the dictated text to that click step's notes and clears the textarea

Narration only attaches to **click** events (not type/submit/navigate). If you dictate but the next event is a navigate or type, the narration stays pending and lands on the next click within a 60-second window.

### Edge cases

- **No click before stop**: pending narration is preserved as a final standalone "note" step at the end of the recording — never silently discarded.
- **Side panel closed mid-recording**: pending narration survives in `chrome.storage` and re-hydrates the textarea when you reopen the panel. The panel persists per-window — pin it via Chrome's puzzle-piece menu if it disappears.
- **Recording started via keyboard shortcut**: `chrome.commands.onCommand` qualifies as a user gesture, so the side panel auto-opens for the active window.
- **Dual-window editing**: edits in the editor broadcast `STEPS_CHANGED` so an open side panel reflects them in real time.

## Notes

- Password fields (`type=password`, `autocomplete=current-password|new-password|cc-number|cc-csc`) are never captured.
- The recorded tab is bound at start; if it closes, recording stops automatically.
- Screenshots are inlined as base64 in the export, so guide files are large but portable.
