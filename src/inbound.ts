import { isJidGroup, jidNormalizedUser, type WAMessage, type WAMessageKey } from '@whiskeysockets/baileys';

import type {
  ChatStreamEvent,
  DiagramAttachment,
  FollowUpOption,
  IncomingTurn,
  OutgoingFileAttachment,
  PendingUserChoice,
} from '@omadia/channel-sdk';

/**
 * Pull plain text out of a WhatsApp message. Returns `undefined` for message
 * kinds we don't route (stickers, reactions, protocol messages, …). We accept
 * plain text, the extended-text form (links/quotes), media captions, and the
 * text echoed back by button/list interactive replies.
 */
export function extractText(msg: WAMessage): string | undefined {
  const m = msg.message;
  if (!m) return undefined;
  const text =
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    m.documentWithCaptionMessage?.message?.documentMessage?.caption ??
    m.buttonsResponseMessage?.selectedButtonId ??
    m.listResponseMessage?.title ??
    m.templateButtonReplyMessage?.selectedId ??
    undefined;
  const trimmed = text?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/** Digits-only phone number from a JID (`4917…@s.whatsapp.net` → `4917…`). */
export function jidToPhone(jid: string): string {
  const user = jid.split('@')[0] ?? '';
  // strip device/agent suffixes like `:12` and any non-digits
  return user.split(':')[0]!.replace(/\D/g, '');
}

/**
 * Real phone numbers (digits-only) this message can be attributed to.
 *
 * WhatsApp increasingly addresses chats by a privacy "LID" (`…@lid`) whose
 * digits are NOT the phone number — so `jidToPhone(remoteJid)` is useless for
 * an allowlist. Baileys still carries the phone-number JID in the
 * `senderPn`/`participantPn` key fields; we collect every phone-form
 * (`@s.whatsapp.net`) JID and ignore the LID ones.
 */
export function phoneCandidates(msg: WAMessage): string[] {
  const key = msg.key as WAMessageKey;
  const jids = [key.remoteJid, key.participant, key.senderPn, key.participantPn];
  const phones = jids
    .filter((j): j is string => typeof j === 'string' && j.endsWith('@s.whatsapp.net'))
    .map(jidToPhone)
    .filter((p) => p.length > 0);
  return [...new Set(phones)];
}

/** Translate a native WhatsApp message into the core `IncomingTurn` shape. */
export function buildIncomingTurn(channelId: string, msg: WAMessage, text: string): IncomingTurn {
  const remoteJid = msg.key.remoteJid ?? '';
  const isGroup = isJidGroup(remoteJid) ?? remoteJid.endsWith('@g.us');
  const senderJid = isGroup ? (msg.key.participant ?? remoteJid) : remoteJid;
  const normalised = senderJid ? jidNormalizedUser(senderJid) : remoteJid;
  return {
    channelId,
    conversationId: remoteJid,
    userRef: {
      kind: 'whatsapp-phone',
      id: normalised,
      ...(msg.pushName ? { displayName: msg.pushName } : {}),
    },
    text,
    metadata: { isGroup, remoteJid, senderJid: normalised },
    rawEvent: msg,
  };
}

/** Normalised, channel-agnostic result drained from a `handleTurnStream`. */
export interface FoldedAnswer {
  answer: string;
  pendingUserChoice?: PendingUserChoice;
  followUpOptions?: FollowUpOption[];
  attachments?: DiagramAttachment[];
  fileAttachments?: OutgoingFileAttachment[];
}

/**
 * Drain the orchestrator stream to its terminal `done` event. We don't stream
 * partial text to WhatsApp (no live message-edit primitive), so only the
 * final answer + sidecars matter. An `error` event is rethrown so the caller
 * can surface a friendly failure message.
 */
export async function foldStream(stream: AsyncIterable<ChatStreamEvent>): Promise<FoldedAnswer> {
  let folded: FoldedAnswer = { answer: '' };
  for await (const ev of stream) {
    if (ev.type === 'done') {
      folded = {
        answer: ev.answer,
        ...(ev.pendingUserChoice ? { pendingUserChoice: ev.pendingUserChoice } : {}),
        ...(ev.followUpOptions ? { followUpOptions: ev.followUpOptions } : {}),
        ...(ev.attachments ? { attachments: ev.attachments } : {}),
        ...(ev.fileAttachments ? { fileAttachments: ev.fileAttachments } : {}),
      };
    } else if (ev.type === 'error') {
      throw new Error(ev.message);
    }
  }
  return folded;
}
