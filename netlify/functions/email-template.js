// ─────────────────────────────────────────────────────────────
// email-template.js
// Shared HTML email components for all Turnfairy automated emails.
//
// Redesigned June 30, 2026 to match a reference email format the
// user liked from a different project ("Misfit Island"): real HTML
// structure (not plain-text-wrapped-in-<br>), a styled section
// header with an underline rule, colored status dots for action
// items, bold key dates, and inline gray owner attribution next to
// each agenda line. Components are composable so each calling
// function builds its body as actual HTML rather than a plain-text
// string that gets wrapped afterward — this is a deliberate move
// away from the original buildHtmlEmail(plainText) approach, which
// could only ever produce <br>-separated text, not real formatting.
// ─────────────────────────────────────────────────────────────

const HUB_URL = 'https://turnfairy-hub.netlify.app';

const COLORS = {
  text: '#1A1520',
  textMuted: '#6B5B8A',
  link: '#603D91',
  accent: '#603D91',
  rule: '#E0D6F5',
  dotUrgent: '#EF4444',
  dotHigh: '#F59E0B',
  dotNormal: '#10B981',
  dotDone: '#9CA3AF',
};

function escapeHtml(str) {
  return String(str === undefined || str === null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Wraps **bold** markers in plain text into real <strong> tags, so
// callers can write natural sentences with a date or label bolded
// without building HTML by hand for every single line.
// Usage: bold("The call is **Monday, July 13** at 8am.")
function bold(text) {
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

// Top hyperlink button — same purple pill used across all emails.
// linkLabel/linkUrl let callers point at Penny's portal instead of
// the main hub where relevant.
function topLink(linkLabel, linkUrl) {
  return `<div style="margin-bottom: 20px;">
    <a href="${linkUrl}" style="display: inline-block; background: ${COLORS.accent}; color: #ffffff; text-decoration: none; padding: 10px 18px; border-radius: 6px; font-weight: 600; font-size: 14px;">
      🔗 ${escapeHtml(linkLabel)}
    </a>
  </div>`;
}

// Styled section header with underline rule — matches the reference
// format's blue bold header + horizontal line (e.g. "Agenda",
// "Open Action Items (35)").
function sectionHeader(title) {
  return `<h2 style="color: ${COLORS.accent}; font-size: 19px; font-weight: 700; margin: 24px 0 4px 0;">${escapeHtml(title)}</h2>
<hr style="border: none; border-top: 1px solid ${COLORS.rule}; margin: 0 0 14px 0;">`;
}

// Subsection label (e.g. department name "Commercial", or a
// person's name "Andrea") — bold, no rule underneath.
function subHeader(title) {
  return `<div style="font-weight: 700; font-size: 14px; margin: 14px 0 6px 0;">${escapeHtml(title)}</div>`;
}

// Status dot color by priority/state. Matches the reference format's
// orange/green dots — orange for anything not yet done that needs
// attention, green for normal/on-track, red reserved for genuinely
// urgent/overdue items.
function statusDotColor(priority) {
  const p = (priority || '').toLowerCase();
  if (p === 'urgent') return COLORS.dotUrgent;
  if (p === 'high') return COLORS.dotHigh;
  if (p === 'done') return COLORS.dotDone;
  return COLORS.dotNormal;
}

function statusDot(priority) {
  return `<span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:${statusDotColor(priority)}; margin-right:8px; flex-shrink:0;"></span>`;
}

// A single agenda line: status dot optional, text, inline gray
// owner name in parens, optional duration suffix ("— 5 min").
// Matches: "• Contracts ending this month (Baji) — 5 min"
function agendaLine({ text, owner, duration, withDot, priority }) {
  const dot = withDot ? statusDot(priority) : '';
  const ownerHtml = owner ? ` <span style="color:${COLORS.textMuted};">(${escapeHtml(owner)})</span>` : '';
  const durationHtml = duration ? ` — ${escapeHtml(String(duration))} min` : '';
  return `<li style="margin-bottom: 6px; line-height: 1.5;">${dot}${escapeHtml(text)}${ownerHtml}${durationHtml}</li>`;
}

// A single action item line with a status dot — used in post-call
// summaries and digest emails, grouped under a person's subHeader.
function actionLine({ text, priority, due, notes }) {
  const dot = statusDot(priority);
  const dueHtml = due ? ` <span style="color:${COLORS.textMuted}; font-size:12px;">— Due ${escapeHtml(due)}</span>` : '';
  const notesHtml = notes ? `<div style="color:${COLORS.textMuted}; font-size:12px; margin-left:16px; margin-top:2px;">${escapeHtml(notes)}</div>` : '';
  return `<li style="margin-bottom: 8px; line-height: 1.5; list-style: none;">${dot}${escapeHtml(text)}${dueHtml}${notesHtml}</li>`;
}

function bulletList(itemsHtml) {
  return `<ul style="margin: 0 0 4px 0; padding-left: 4px; list-style-position: inside;">${itemsHtml.join('')}</ul>`;
}

// A decision line — checkmark prefix, no status dot (decisions are
// resolved by definition, not pending).
function decisionLine({ text, decisionMaker }) {
  const makerHtml = decisionMaker ? ` <span style="color:${COLORS.textMuted};">(${escapeHtml(decisionMaker)})</span>` : '';
  return `<li style="margin-bottom: 6px; line-height: 1.5; list-style: none;"><span style="color:${COLORS.dotNormal}; margin-right:8px;">✓</span>${escapeHtml(text)}${makerHtml}</li>`;
}

function paragraph(html) {
  return `<p style="margin: 0 0 14px 0; line-height: 1.6;">${html}</p>`;
}

// Full HTML shell — wraps any pre-built HTML body content (built
// from the components above) in the standard email frame with the
// top hyperlink button.
function htmlShell(bodyHtml, opts = {}) {
  const linkLabel = opts.linkLabel || 'Manager Hub';
  const linkUrl = opts.linkUrl || HUB_URL;

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family: -apple-system, Segoe UI, Helvetica, Arial, sans-serif; color: ${COLORS.text}; line-height: 1.5; max-width: 640px; margin: 0 auto; padding: 16px; font-size: 14px;">
  ${topLink(linkLabel, linkUrl)}
  ${bodyHtml}
</body>
</html>`;
}

// ── Backward-compatible plain-text fallback ───────────────────
// Kept for any caller not yet migrated to the component builders
// above. Converts a plain-text body into <br>-separated HTML —
// this is the OLD behavior, retained only so nothing breaks if a
// function still passes plain text instead of building real HTML.
function textToHtml(text) {
  return escapeHtml(text).replace(/\n/g, '<br>');
}
function buildHtmlEmail(plainTextBody, opts = {}) {
  return htmlShell(`<div style="white-space: normal;">${textToHtml(plainTextBody)}</div>`, opts);
}

module.exports = {
  // new component-based builders
  htmlShell, topLink, sectionHeader, subHeader,
  agendaLine, actionLine, decisionLine, bulletList, paragraph, bold,
  statusDot, statusDotColor, escapeHtml,
  // legacy plain-text fallback, kept for compatibility
  buildHtmlEmail, textToHtml,
  HUB_URL, COLORS,
};
