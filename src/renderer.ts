import type { DiagramAttachment, FollowUpOption, OutgoingFileAttachment, PendingUserChoice } from '@omadia/channel-sdk';

import type { FoldedAnswer } from './inbound.js';

/**
 * Render the channel-agnostic answer into a single WhatsApp text message.
 *
 * WhatsApp (Baileys) has no Adaptive-Card / inline-keyboard primitive we can
 * rely on, so every richer element degrades to text: choice cards become a
 * "reply with one of these" list, follow-ups become copyable suggestions, and
 * attachments become links. This matches the SDK's documented graceful-
 * degradation contract for connectors without rich UI.
 */
export function renderAnswer(a: FoldedAnswer): string {
  const parts: string[] = [];

  const body = mdToWhatsApp(a.answer).trim();
  if (body) parts.push(body);

  if (a.pendingUserChoice && a.pendingUserChoice.options.length > 0) {
    parts.push(renderChoice(a.pendingUserChoice));
  }

  const links = renderAttachments(a.attachments, a.fileAttachments);
  if (links) parts.push(links);

  if (a.followUpOptions && a.followUpOptions.length > 0) {
    parts.push(renderFollowUps(a.followUpOptions));
  }

  return parts.join('\n\n');
}

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

function renderChoice(choice: PendingUserChoice): string {
  const lines = [`*${choice.question}*`];
  if (choice.rationale) lines.push(`_${choice.rationale}_`);
  for (const opt of choice.options) lines.push(`• ${opt.label}`);
  lines.push('_Bitte antworte mit einer der Optionen._');
  return lines.join('\n');
}

function renderFollowUps(followUps: FollowUpOption[]): string {
  const lines = ['💡 _Du kannst auch fragen:_'];
  for (const f of followUps.slice(0, 5)) lines.push(`• ${f.prompt}`);
  return lines.join('\n');
}

function renderAttachments(
  images: DiagramAttachment[] | undefined,
  files: OutgoingFileAttachment[] | undefined,
): string | undefined {
  const lines: string[] = [];
  for (const img of images ?? []) lines.push(`🖼 ${img.altText}: ${img.url}`);
  for (const file of files ?? []) lines.push(`📎 ${file.altText}: ${file.url}`);
  return lines.length > 0 ? lines.join('\n') : undefined;
}
