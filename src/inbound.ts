import { isJidGroup, jidNormalizedUser, type WAMessage, type WAMessageKey } from '@whiskeysockets/baileys';

import {
  channelUserPrincipal,
  parsePrincipal,
  parseSessionScope,
  turnPrincipal,
  type ChatStreamEvent,
  DiagramAttachment,
  FollowUpOption,
  IncomingTurn,
  OutgoingFileAttachment,
  PendingUserChoice,
  TurnOrigin,
} from '@omadia/channel-sdk';

/** `ChannelUserRef.kind` and `TurnOrigin.channelType` of WhatsApp turns. */
const USER_KIND = 'whatsapp-phone' as const;
const CHANNEL_TYPE = 'whatsapp';

/** The session scope the plugin has always used for a WhatsApp conversation. */
export function sessionScopeOf(conversationId: string): string {
  return `${CHANNEL_TYPE}:${conversationId}`;
}

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

const PHONE_JID_SERVER = '@s.whatsapp.net';

/**
 * The sender's phone-number JID, when WhatsApp reveals it.
 *
 * WhatsApp addresses a person either by phone number (`…@s.whatsapp.net`) or
 * by a privacy LID (`…@lid`), and LID-only groups are the common case now. The
 * LID digits are not a phone number, and the same person can show up as a LID
 * in one chat and as a number in another. Baileys carries the number in
 * `senderPn` (direct) / `participantPn` (group) next to the LID.
 */
function senderPhoneJid(msg: WAMessage, isGroup: boolean): string | undefined {
  const key = msg.key as WAMessageKey;
  const candidates = isGroup ? [key.participant, key.participantPn] : [key.remoteJid, key.senderPn];
  const phone = candidates.find((j): j is string => typeof j === 'string' && j.endsWith(PHONE_JID_SERVER));
  return phone ? jidNormalizedUser(phone) : undefined;
}

/** The id of the message a message replies to, when it is a reply. */
function quotedMessageIdOf(msg: WAMessage): string | undefined {
  const message = msg.message as Record<string, unknown> | null | undefined;
  for (const value of Object.values(message ?? {})) {
    if (value && typeof value === 'object' && 'contextInfo' in value) {
      const info = (value as { contextInfo?: { stanzaId?: string | null } | null }).contextInfo;
      if (info?.stanzaId) return info.stanzaId;
    }
  }
  return undefined;
}

/**
 * The person as the ONE principal form of every channel (spec 2042 §5.3):
 * `user:whatsapp-phone:<jid>`, built by the SDK, never by hand.
 *
 * LID decision: the principal id is the phone-number JID whenever WhatsApp
 * reveals it (`metadata.senderPhoneJid`), so one person is one principal in a
 * direct chat and in any group, and an operator can name them by number. Only
 * when WhatsApp shows nothing but the LID, the LID JID is the id. Such a
 * person has a separate principal (their `/agent` selection does not carry to
 * the chat where their number is visible): the LID-to-number mapping is not
 * available to a plugin at turn time, and guessing one would merge people.
 * `userRef.id` (memory keys, roster, audience check) stays the JID WhatsApp
 * addresses the sender by in that chat.
 */
export function principalRefOf(turn: IncomingTurn): { kind: string; id: string } {
  const phone = turn.metadata?.['senderPhoneJid'];
  return { kind: turn.userRef.kind, id: typeof phone === 'string' && phone.length > 0 ? phone : turn.userRef.id };
}

/** The principal a turn is routed by: `turnPrincipal` of the sender and the origin's principal. */
export function routePrincipalOf(turn: IncomingTurn, origin: TurnOrigin): string {
  return turnPrincipal(principalRefOf(turn), origin.principal);
}

/**
 * Where a turn came from, stated by the channel (spec 2042 INV-1, §5.8): the
 * platform's own group-vs-direct statement, the conversation id exactly as the
 * adapter addresses it, and the speaking person. The scope is the one the
 * plugin already used as `sessionScope`, so no existing memory key changes.
 */
export function buildTurnOrigin(turn: IncomingTurn, messageId: string | undefined): TurnOrigin {
  const principal = parsePrincipal(channelUserPrincipal(principalRefOf(turn)));
  return {
    channelType: CHANNEL_TYPE,
    scope: parseSessionScope(sessionScopeOf(turn.conversationId)),
    ...(principal ? { principal } : {}),
    ...(turn.conversationType ? { conversationType: turn.conversationType } : {}),
    channelConversationId: turn.conversationId,
    ...(messageId ? { messageId } : {}),
    speaker: {
      kind: turn.userRef.kind,
      id: turn.userRef.id,
      ...(turn.userRef.displayName ? { displayName: turn.userRef.displayName } : {}),
    },
  };
}

/**
 * Translate a native WhatsApp message into the core `IncomingTurn` shape.
 * The text is passed through verbatim, so `/agent`, `/agent <Name>` and
 * `/agents` reach the agent the channel resolver returns as ordinary messages
 * (WhatsApp has no native bot commands); that agent carries them out.
 */
export function buildIncomingTurn(channelId: string, msg: WAMessage, text: string): IncomingTurn {
  const remoteJid = msg.key.remoteJid ?? '';
  const isGroup = isJidGroup(remoteJid) ?? remoteJid.endsWith('@g.us');
  const senderJid = isGroup ? (msg.key.participant ?? remoteJid) : remoteJid;
  const normalised = senderJid ? jidNormalizedUser(senderJid) : remoteJid;
  const phoneJid = senderPhoneJid(msg, isGroup);
  const quotedMessageId = quotedMessageIdOf(msg);
  return {
    channelId,
    channelType: CHANNEL_TYPE,
    channelKey: remoteJid,
    conversationId: remoteJid,
    conversationType: isGroup ? 'group' : 'direct',
    userRef: {
      kind: USER_KIND,
      id: normalised,
      ...(msg.pushName ? { displayName: msg.pushName } : {}),
    },
    text,
    metadata: {
      isGroup,
      remoteJid,
      senderJid: normalised,
      ...(phoneJid ? { senderPhoneJid: phoneJid } : {}),
      ...(quotedMessageId ? { quotedMessageId } : {}),
    },
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
