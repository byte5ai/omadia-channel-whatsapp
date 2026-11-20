import {
  parsePrincipal,
  type ChannelUserRef,
  type ConversationSendProvider,
  type SendProviderCapabilities,
  type TargetedDeliveryOutcome,
  type TargetedMessage,
  type TargetedSendProvider,
} from '@omadia/channel-sdk';

import { WHATSAPP_CHANNEL_TYPE, systemAnswer, type AnswerEmitter } from './emit.js';
import { jidToPhone } from './inbound.js';
import { attachmentLines } from './renderer.js';

/**
 * What the providers DECLARE: nothing. Deliberately absent:
 *  - `asChannelKey`: this installation is ONE WhatsApp number. It cannot post
 *    as another agent's own identity, and the kernel must not be told it can.
 *  - `mentions`, `aiLabel`: the kernel degrades to plain text and folds the
 *    disclosure line into the text.
 *  - `poll`, `card`: the kernel posts a poll or card this channel does not
 *    show natively as numbered text in an ordinary message, keeps the open
 *    question and turns a typed reply into the `card_answer` (spec 2042 §5.14,
 *    criterion 30). The plugin only reports the id of the message it sent and
 *    emits its inbound messages with `replyToMessageId` / `addressedToBot`.
 */
export const WHATSAPP_SEND_CAPABILITIES: SendProviderCapabilities = Object.freeze({});

export interface SendPolicy {
  /** Groups are not posted into when the operator keeps the bot out of them. */
  readonly ignoreGroups: boolean;
  /** Digits-only phone numbers the bot may message (empty = no restriction). */
  readonly allowlist: ReadonlySet<string>;
}

export interface WhatsAppSendProviderDeps {
  readonly emitter: Pick<AnswerEmitter, 'emit'>;
  readonly policy: SendPolicy;
}

const NO_NAMED_IDENTITY =
  'this WhatsApp installation is one number and cannot send as a named identity — nothing was posted, so nothing went out under another agent\'s name';

function unreachable(
  code: Extract<TargetedDeliveryOutcome, { outcome: 'unreachable' }>['code'],
  message: string,
): TargetedDeliveryOutcome {
  return { outcome: 'unreachable', code, message };
}

const isGroupJid = (jid: string): boolean => jid.endsWith('@g.us');
const isUserJid = (jid: string): boolean => jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid');

/** The JID a targeted send goes to: the channel user, else a `user:whatsapp-phone:<jid>` principal. */
export function jidForTarget(target: { principalId: string; userRef?: ChannelUserRef }): string | undefined {
  if (target.userRef?.kind === 'whatsapp-phone' && isUserJid(target.userRef.id.toLowerCase())) {
    return target.userRef.id.toLowerCase();
  }
  const principal = parsePrincipal(target.principalId);
  if (principal?.kind !== 'user') return undefined;
  const prefix = 'whatsapp-phone:';
  if (!principal.userId.startsWith(prefix)) return undefined;
  const jid = principal.userId.slice(prefix.length);
  return isUserJid(jid) ? jid : undefined;
}

/**
 * Post one message as `system` (the plugin cannot name an agent here), through
 * the single emitter. A poll or card is refused, not posted as plain text: the
 * kernel converts those before they reach a channel that declares neither.
 */
async function deliver(
  deps: WhatsAppSendProviderDeps,
  jid: string,
  message: TargetedMessage,
): Promise<TargetedDeliveryOutcome> {
  if (message.poll || message.card) {
    return unreachable('channel_error', 'the WhatsApp channel posts no native polls or cards — nothing was posted');
  }
  const text = [message.text, attachmentLines(message.attachments)].filter((part) => part.trim().length > 0).join('\n\n');
  try {
    // The WhatsApp message id: what a reply to this message names as its quote.
    const messageId = await deps.emitter.emit(jid, systemAnswer(text));
    return { outcome: 'delivered', ...(messageId ? { messageId } : {}), conversationId: jid };
  } catch (err) {
    return unreachable('channel_error', (err as Error).message);
  }
}

/** A person may be messaged when the operator's allowlist is empty or names their number; a LID shows no number, so it never passes a set allowlist. */
function isAllowedRecipient(jid: string, policy: SendPolicy): boolean {
  if (policy.allowlist.size === 0) return true;
  return jid.endsWith('@s.whatsapp.net') && policy.allowlist.has(jidToPhone(jid));
}

export function createWhatsAppSendProviders(deps: WhatsAppSendProviderDeps): {
  readonly targeted: TargetedSendProvider;
  readonly conversation: ConversationSendProvider;
} {
  const supports = WHATSAPP_SEND_CAPABILITIES;
  return {
    targeted: {
      channelType: WHATSAPP_CHANNEL_TYPE,
      supports,
      async sendToUser(target, message, opts) {
        if (opts?.asChannelKey !== undefined) return unreachable('not_permitted', NO_NAMED_IDENTITY);
        const jid = jidForTarget(target);
        if (!jid) {
          return unreachable(
            'user_not_found',
            'WhatsApp addresses a person by phone number (user:whatsapp-phone:<jid>); this principal names none',
          );
        }
        if (!isAllowedRecipient(jid, deps.policy)) {
          return unreachable('not_permitted', 'the operator\'s allowlist does not include this number');
        }
        return deliver(deps, jid, message);
      },
    },
    conversation: {
      channelType: WHATSAPP_CHANNEL_TYPE,
      supports,
      async sendToConversation(conversationId, message, opts) {
        if (opts?.asChannelKey !== undefined) return unreachable('not_permitted', NO_NAMED_IDENTITY);
        const jid = conversationId.trim().toLowerCase();
        if (!isGroupJid(jid) && !isUserJid(jid)) {
          return unreachable('no_binding', `'${conversationId}' is not a WhatsApp conversation id`);
        }
        if (isGroupJid(jid) && deps.policy.ignoreGroups) {
          return unreachable('not_permitted', 'the operator keeps this bot out of groups (ignore_groups)');
        }
        if (!isGroupJid(jid) && !isAllowedRecipient(jid, deps.policy)) {
          return unreachable('not_permitted', 'the operator\'s allowlist does not include this number');
        }
        return deliver(deps, jid, message);
      },
    },
  };
}
