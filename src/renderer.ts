import type {
  FollowUpOption,
  OutgoingAttachment,
  OutgoingChoiceCard,
  SemanticAnswer,
} from '@omadia/channel-sdk';

/**
 * Render the orchestrator's channel-agnostic {@link SemanticAnswer} into a
 * single WhatsApp text message.
 *
 * WhatsApp (Baileys) has no Adaptive-Card / inline-keyboard primitive we can
 * rely on, so every richer element degrades to text: a choice card becomes a
 * "reply with one of these" list, follow-ups become copyable suggestions, and
 * attachments become links. This matches the SDK's documented graceful-
 * degradation contract for connectors without rich UI.
 */
export function renderAnswer(a: SemanticAnswer): string {
  const parts: string[] = [];

  const body = mdToWhatsApp(a.text).trim();
  if (body) parts.push(body);

  if (a.interactive?.kind === 'choice') {
    parts.push(renderChoice(a.interactive));
  }

  const links = renderAttachments(a.attachments);
  if (links) parts.push(links);

  if (a.followUps && a.followUps.length > 0) {
    parts.push(renderFollowUps(a.followUps));
  }

  if (a.disclaimer) parts.push(`_${a.disclaimer}_`);

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

function renderChoice(choice: OutgoingChoiceCard): string {
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

function renderAttachments(items: OutgoingAttachment[] | undefined): string | undefined {
  const lines: string[] = [];
  for (const a of items ?? []) {
    const icon = a.kind === 'image' ? '🖼' : '📎';
    lines.push(`${icon} ${a.altText}: ${a.url}`);
  }
  return lines.length > 0 ? lines.join('\n') : undefined;
}
