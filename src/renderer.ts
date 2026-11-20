import type { OutgoingAttachment } from '@omadia/channel-sdk';

/**
 * Best-effort Markdown → WhatsApp formatting. WhatsApp uses `*bold*`,
 * `_italic_`, `~strike~` and ``` ```mono``` ```. We only do the safe, common
 * conversions and leave anything ambiguous untouched.
 */
export function mdToWhatsApp(md: string): string {
  return md
    // **bold** / __bold__  →  *bold*
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '*$1*')
    // [label](url)  →  label (url)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1 ($2)')
    // strip leading markdown heading hashes, keep the heading text bold
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*');
}

/**
 * Attachments are content, not decoration: each one becomes a plain
 * "label: url" line. No icon, no badge (spec 2042 §5.14).
 */
export function attachmentLines(items: readonly OutgoingAttachment[] | undefined): string {
  return (items ?? []).map((a) => `${a.altText}: ${a.url}`).join('\n');
}
