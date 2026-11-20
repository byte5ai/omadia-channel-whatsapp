import {
  parsePrincipal,
  renderCardAsText,
  type CardQuestionKind,
  type CardSupport,
  type ChannelUserRef,
  type ConversationSendProvider,
  type QuestionCard,
  type SendProviderCapabilities,
  type TargetedDeliveryOutcome,
  type TargetedMessage,
  type TargetedSendProvider,
} from '@omadia/channel-sdk';

import { WHATSAPP_CHANNEL_TYPE, systemAnswer, type AnswerEmitter } from './emit.js';
import { jidToPhone } from './inbound.js';
import { OpenCardRegistry, pollProblem, pollToCard, type OpenCardKind } from './openCards.js';
import { attachmentLines } from './renderer.js';

/**
 * Question kinds a person can answer in plain text and `parseCardReply` can
 * read back. `assignment` is left out: its candidates are the conversation
 * members, which a numbered text cannot name.
 */
export const WHATSAPP_CARD_KINDS: readonly CardQuestionKind[] = Object.freeze([
  'single_choice',
  'multiple_choice',
  'ranking',
  'consent',
  'text',
  'number',
  'date',
]);

/** One question per card: a typed reply answers exactly one question. A longer card is refused and the sender falls back to a chat ballot. */
export const WHATSAPP_CARD_SUPPORT: CardSupport = Object.freeze({
  kinds: WHATSAPP_CARD_KINDS,
  maxQuestions: 1,
  update: false,
});

/**
 * What the providers DECLARE. Deliberately absent:
 *  - `asChannelKey`: this installation is ONE WhatsApp number. It cannot post
 *    as another agent's own identity, and the kernel must not be told it can.
 *  - `mentions`, `aiLabel`: the kernel degrades to plain text and folds the
 *    disclosure line into the text.
 * Polls and cards are declared only when typed answers can be received.
 */
export function whatsAppSendCapabilities(canReceiveCardAnswers: boolean): SendProviderCapabilities {
  return canReceiveCardAnswers ? { poll: true, card: WHATSAPP_CARD_SUPPORT } : {};
}

export interface SendPolicy {
  /** Groups are not posted into when the operator keeps the bot out of them. */
  readonly ignoreGroups: boolean;
  /** Digits-only phone numbers the bot may message (empty = no restriction). */
  readonly allowlist: ReadonlySet<string>;
}

export interface WhatsAppSendProviderDeps {
  readonly emitter: Pick<AnswerEmitter, 'emit'>;
  readonly cards: OpenCardRegistry;
  readonly policy: SendPolicy;
  /** The kernel can take `card_answer` events (`core.emitConversationMessage`). */
  readonly canReceiveCardAnswers: boolean;
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

type Built =
  | { readonly text: string; readonly open?: { readonly kind: OpenCardKind; readonly card: QuestionCard } }
  | { readonly refusal: TargetedDeliveryOutcome };

/** Plain text of a message: its text, attachments as "label: url", and a poll or card as a numbered question. */
function buildText(message: TargetedMessage): Built {
  if (message.poll && message.card) {
    return { refusal: unreachable('channel_error', 'a message is a poll or a question card, not both') };
  }
  let question: { kind: OpenCardKind; card: QuestionCard } | undefined;
  if (message.poll) {
    const problem = pollProblem(message.poll);
    if (problem) return { refusal: unreachable('channel_error', `invalid poll: ${problem}`) };
    question = { kind: 'poll', card: pollToCard(message.poll) };
  } else if (message.card) {
    const card = message.card;
    const unsupported = card.questions.find((q) => !WHATSAPP_CARD_KINDS.includes(q.kind));
    if (card.questions.length !== WHATSAPP_CARD_SUPPORT.maxQuestions || unsupported) {
      return {
        refusal: unreachable(
          'channel_error',
          'the WhatsApp channel posts one question per card, of a kind a typed reply can answer — nothing was posted',
        ),
      };
    }
    question = { kind: 'card', card };
  }
  const text = [message.text, attachmentLines(message.attachments), question ? renderCardAsText(question.card) : '']
    .filter((part) => part.trim().length > 0)
    .join('\n\n');
  return { text, ...(question ? { open: question } : {}) };
}

/** Post one message as `system` (the plugin cannot name an agent here), through the single emitter. */
async function deliver(
  deps: WhatsAppSendProviderDeps,
  jid: string,
  message: TargetedMessage,
): Promise<TargetedDeliveryOutcome> {
  const built = buildText(message);
  if ('refusal' in built) return built.refusal;
  if (built.open && !deps.canReceiveCardAnswers) {
    return unreachable('channel_error', 'the kernel cannot take typed answers on this channel — post the question as text');
  }
  try {
    const messageId = await deps.emitter.emit(jid, systemAnswer(built.text));
    if (built.open) {
      deps.cards.open({
        kind: built.open.kind,
        conversationId: jid,
        card: built.open.card,
        ...(messageId ? { messageId } : {}),
      });
    }
    return {
      outcome: 'delivered',
      ...(messageId ? { messageId } : {}),
      ...(built.open && messageId ? { cardMessageId: messageId } : {}),
      conversationId: jid,
    };
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
  const supports = whatsAppSendCapabilities(deps.canReceiveCardAnswers);
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
