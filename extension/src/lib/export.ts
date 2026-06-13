import type { Recording, Step } from './types';
import { getScreenshot } from './storage';
import { bakeOverlays } from './highlight';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Inline markdown-lite — escapes first, then re-applies tags safely. */
function renderInline(s: string): string {
  let out = escapeHtml(s);
  // [text](url) — links. Both fields are already HTML-escaped, so we only need
  // to validate the URL scheme to avoid `javascript:` payloads.
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text, href) => {
    const safe = /^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i.test(href) ? href : '#';
    return `<a href="${safe}" rel="noopener noreferrer" target="_blank">${text}</a>`;
  });
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  return out;
}

/** Render multi-line notes as paragraphs separated by blank lines. */
function renderNotes(notes: string): string {
  const paragraphs = notes
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  return paragraphs
    .map((p) => `<p>${renderInline(p).replace(/\n/g, '<br />')}</p>`)
    .join('\n');
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + chunk)));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}

/** Resolve a step's screenshot (with overlays baked in) to a base64 data URL,
 * or null if the step has no screenshot. Shared by both export paths. */
async function stepImageDataUrl(step: Step): Promise<string | null> {
  if (!step.screenshotId) return null;
  const blob = await getScreenshot(step.screenshotId);
  if (!blob) return null;
  const baked = await bakeOverlays(blob, step.overlays);
  return blobToDataUrl(baked);
}

/** Trigger a browser download of an HTML string. Shared by both export paths. */
function downloadHtml(html: string, filename: string): void {
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function safeFilename(name: string): string {
  return name.replace(/[^\w\d-]+/g, '-').slice(0, 80);
}

const STYLES = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #f7f7f8;
    color: #111;
    line-height: 1.55;
  }
  .container { max-width: 880px; margin: 0 auto; padding: 48px 24px 96px; }
  header h1 { font-size: 28px; margin: 0 0 4px; color: #111; }
  header .meta { color: #666; font-size: 13px; margin-bottom: 32px; }
  .step { background: #ffffff; border: 1px solid #e6e6e9; border-radius: 12px; padding: 20px 24px; margin: 16px 0; box-shadow: 0 1px 2px rgba(0,0,0,0.03); }
  .step-header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 12px; }
  .step-number { background: #1464dc; color: white; border-radius: 999px; width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; font-weight: 600; font-size: 13px; flex: 0 0 auto; }
  .step-body { font-size: 16px; color: #111; }
  .step-body code { background: #f0f0f3; padding: 1px 6px; border-radius: 4px; font-size: 13px; color: #111; }
  .step-body a { color: #1464dc; }
  .step-notes { color: #444; font-size: 15px; margin: 8px 0 0 40px; }
  .step-notes p { margin: 8px 0; }
  .step-notes code { background: #f0f0f3; padding: 1px 6px; border-radius: 4px; font-size: 13px; color: #111; }
  .step-notes a { color: #1464dc; }
  .step-url { color: #888; font-size: 12px; margin-top: 6px; word-break: break-all; }
  .step img { width: 100%; height: auto; border-radius: 8px; margin-top: 14px; border: 1px solid #e6e6e9; display: block; }
  footer { color: #999; font-size: 12px; text-align: center; margin-top: 48px; }
`;

export async function buildHtmlGuide(
  recording: Recording,
  steps: Step[],
): Promise<string> {
  const renderedSteps: string[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const description = step.customDescription ?? step.description;
    const dataUrl = await stepImageDataUrl(step);
    const img = dataUrl
      ? `<img src="${dataUrl}" alt="Step ${i + 1} screenshot" loading="lazy" />`
      : '';
    const notes = step.notes && step.notes.trim() ? renderNotes(step.notes) : '';
    renderedSteps.push(`
      <div class="step">
        <div class="step-header">
          <span class="step-number">${i + 1}</span>
          <div class="step-body">${renderInline(description)}</div>
        </div>
        ${notes ? `<div class="step-notes">${notes}</div>` : ''}
        ${step.url ? `<div class="step-url">${escapeHtml(step.url)}</div>` : ''}
        ${img}
      </div>
    `);
  }

  const created = new Date(recording.createdAt).toLocaleString();

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(recording.name)}</title>
  <style>${STYLES}</style>
</head>
<body>
  <div class="container">
    <header>
      <h1>${escapeHtml(recording.name)}</h1>
      <div class="meta">${steps.length} step${steps.length === 1 ? '' : 's'} &middot; recorded ${escapeHtml(created)}</div>
    </header>
    <main>
      ${renderedSteps.join('\n')}
    </main>
    <footer>Generated by Echo</footer>
  </div>
</body>
</html>`;
}

/** Build the polished standalone HTML guide and trigger a browser download.
 * Used from both the editor and the side panel. */
export async function downloadHtmlGuide(
  recording: Recording,
  steps: Step[],
): Promise<void> {
  const html = await buildHtmlGuide(recording, steps);
  downloadHtml(html, `${safeFilename(recording.name)}.html`);
}

/**
 * Build a Google Docs–friendly HTML representation of the guide.
 *
 * Unlike `buildHtmlGuide`, this emits clean, semantic, *unstyled* markup —
 * real <h1>/<h2> headings, <p> paragraphs, and <img> elements with NO
 * background colors, borders, or layout CSS. That matters because Google Docs'
 * import/paste converts CSS `background` into text highlighting and ignores
 * most other styling, so a styled export lands as highlighted, mis-formatted
 * text. Semantic-only markup maps straight onto Docs' native Heading/Normal
 * styles (and gives you a real document outline).
 *
 * Recommended use: download, then in Google Drive choose "Open with → Google
 * Docs". The importer pulls in the inline screenshots and applies heading
 * styles automatically.
 */
export async function buildDocsHtml(
  recording: Recording,
  steps: Step[],
): Promise<string> {
  const blocks: string[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const description = step.customDescription ?? step.description;
    blocks.push(`<h2>${i + 1}. ${renderInline(description)}</h2>`);
    if (step.notes && step.notes.trim()) {
      blocks.push(renderNotes(step.notes));
    }
    if (step.url) {
      blocks.push(`<p><em>${escapeHtml(step.url)}</em></p>`);
    }
    const dataUrl = await stepImageDataUrl(step);
    if (dataUrl) {
      blocks.push(`<p><img src="${dataUrl}" alt="Step ${i + 1} screenshot" /></p>`);
    }
  }

  // No <style> block by design — see the doc comment above.
  // No step-count / timestamp subtitle — the title should be the only heading.
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(recording.name)}</title>
</head>
<body>
  <h1>${escapeHtml(recording.name)}</h1>
  ${blocks.join('\n  ')}
</body>
</html>`;
}

/** Build the Google Docs–friendly guide and trigger a browser download. */
export async function downloadDocsGuide(
  recording: Recording,
  steps: Step[],
): Promise<void> {
  const html = await buildDocsHtml(recording, steps);
  downloadHtml(html, `${safeFilename(recording.name)}-google-docs.html`);
}
