// ─────────────────────────────────────────────────────────────
// email-template.js
// Shared HTML email wrapper for all Turnfairy automated emails.
// Wraps a plain-text body in a minimal HTML shell with a real
// clickable "Manager Hub" link near the top, and converts the
// plain-text body into HTML paragraphs/line breaks so existing
// callers don't need to be rewritten line-by-line.
// ─────────────────────────────────────────────────────────────

const HUB_URL = 'https://turnfairy-hub.netlify.app';

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Converts a plain-text body (as built by the existing functions)
// into HTML, preserving line breaks. Does not try to be clever —
// just escapes and replaces \n with <br>, so existing body-building
// code in each function can stay exactly as-is.
function textToHtml(text) {
  return escapeHtml(text).replace(/\n/g, '<br>');
}

// Wraps a plain-text email body in a minimal HTML email shell with
// a real <a> hyperlink to the Manager Hub near the top.
// linkLabel/linkUrl let callers override the top link (e.g. Penny's
// portal link instead of the main hub) — defaults to "Manager Hub".
function buildHtmlEmail(plainTextBody, opts = {}) {
  const linkLabel = opts.linkLabel || 'Manager Hub';
  const linkUrl = opts.linkUrl || HUB_URL;

  const bodyHtml = textToHtml(plainTextBody);

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family: -apple-system, Segoe UI, Helvetica, Arial, sans-serif; color: #1A1520; line-height: 1.5; max-width: 640px; margin: 0 auto; padding: 16px;">
  <div style="margin-bottom: 18px;">
    <a href="${linkUrl}" style="display: inline-block; background: #603D91; color: #ffffff; text-decoration: none; padding: 10px 18px; border-radius: 6px; font-weight: 600; font-size: 14px;">
      🔗 ${escapeHtml(linkLabel)}
    </a>
  </div>
  <div style="font-size: 14px; white-space: normal;">
    ${bodyHtml}
  </div>
</body>
</html>`;
}

module.exports = { buildHtmlEmail, textToHtml, escapeHtml, HUB_URL };
