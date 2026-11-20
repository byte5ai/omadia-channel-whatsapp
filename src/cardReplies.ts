import {
  parseCardReply,
  type CardAnswerValue,
  type ConversationMessageEvent,
  type IncomingTurn,
  type LogLevel,
} from '@omadia/channel-sdk';

import { WHATSAPP_CHANNEL_TYPE, systemAnswer, type AnswerEmitter } from './emit.js';
import type { OwnIdentity } from './groupAddressing.js';
import { messageIdOf } from './inbound.js';
import { OpenCardRegistry, type OpenCard } from './openCards.js';

export const CARD_ANSWER_RECORDED_TEXT = 'Danke, deine Antwort ist notiert.';
export const CARD_ANSWER_NOT_UNDERSTOOD_TEXT =
  'Das habe ich nicht als Antwort auf die Frage verstanden. Bitte antworte noch einmal direkt darauf.';

/**
 * The identity key of this installation in `card_answer` events: the linked
 * account, in the form `whatsapp:<jid>`. The kernel has no per-agent identity
 * key for WhatsApp (one number serves every agent), so this is the only key
 * the plugin can state; it is empty until the account is linked.
 */
export function whatsAppInstallationKey(own: OwnIdentity): string | undefined {
  const id = own.jid || own.lid;
  return id ? `${WHATSAPP_CHANNEL_TYPE}:${id}`.toLowerCase() : undefined;
}

export interface CardReplyDeps {
  readonly channelId: string;
  readonly registry: OpenCardRegistry;
  readonly emitter: Pick<AnswerEmitter, 'emit'>;
  /** `core.emitConversationMessage`: the kernel stores the typed answer. */
  readonly emitMessage: (event: ConversationMessageEvent) => void;
  readonly installationKey: () => string | undefined;
  readonly log: (level: LogLevel, message: string, context?: Record<string, unknown>) => void;
  readonly now?: () => Date;
}

export interface CardReplyHandler {
  /**
   * Take a typed message as the answer to an open question, when it is one.
   * Resolves `true` when the message was consumed (the agent must not also
   * answer it), `false` when it is an ordinary message.
   */
  tryHandle(turn: IncomingTurn): Promise<boolean>;
}

/** A free-text question takes only a message that replies to it: any other text is ordinary conversation. */
function needsExplicitReply(open: OpenCard): boolean {
  return open.card.questions[0]?.kind === 'text';
}

function cardAnswerOf(open: OpenCard, value: CardAnswerValue): NonNullable<ConversationMessageEvent['cardAnswer']> {
  if (open.kind === 'poll' && value.kind === 'single_choice') {
    return { cardId: open.card.cardId, value: { optionId: value.optionId }, answererVerified: true };
  }
  return {
    cardId: open.card.cardId,
    value: { answers: [value] },
    answererVerified: true,
    answers: [value],
    ...(open.card.proposalId !== undefined ? { proposalId: open.card.proposalId } : {}),
    ...(open.card.proposalVersion !== undefined ? { proposalVersion: open.card.proposalVersion } : {}),
  };
}

/**
 * Criterion 30 on WhatsApp: a poll or question card went out as numbered text
 * (`renderCardAsText`), and the person answers by typing (`parseCardReply`).
 * The typed answer reaches the kernel as the same typed `card_answer` event a
 * card submission would produce, so its receiver cannot tell the difference.
 *
 * WhatsApp states who wrote the message, so the answer is verified by the
 * platform. In a group, only a message that reached the bot at all (mention or
 * a reply to one of its messages) is seen here.
 */
export function createCardReplyHandler(deps: CardReplyDeps): CardReplyHandler {
  const now = deps.now ?? (() => new Date());
  return {
    async tryHandle(turn) {
      try {
        const quoted = turn.metadata?.['quotedMessageId'];
        const quotedId = typeof quoted === 'string' ? quoted : undefined;
        const open = deps.registry.find(turn.conversationId, quotedId);
        const question = open?.card.questions[0];
        const key = deps.installationKey();
        if (!open || !question || !key) return false;

        const repliesToCard = quotedId !== undefined && quotedId === open.messageId;
        if (needsExplicitReply(open) && !repliesToCard) return false;

        const parsed = parseCardReply(question, turn.text);
        if (!parsed.ok) {
          if (!repliesToCard) return false;
          await deps.emitter.emit(turn.conversationId, systemAnswer(CARD_ANSWER_NOT_UNDERSTOOD_TEXT));
          return true;
        }

        deps.emitMessage({
          channelId: deps.channelId,
          channelType: WHATSAPP_CHANNEL_TYPE,
          conversationId: turn.conversationId,
          ...(turn.conversationType ? { conversationType: turn.conversationType } : {}),
          receivedByChannelKey: key,
          messageId: open.messageId ?? messageIdOf(turn) ?? open.card.cardId,
          revision: 0,
          kind: 'card_answer',
          author: turn.userRef,
          cardAnswer: cardAnswerOf(open, parsed.value),
          occurredAt: now().toISOString(),
          rawEvent: turn.rawEvent,
        });
        // A poll to one person is answered once; in a group several people answer the same question.
        if (turn.conversationType !== 'group') deps.registry.close(turn.conversationId, open.card.cardId);
        await deps.emitter.emit(turn.conversationId, systemAnswer(CARD_ANSWER_RECORDED_TEXT));
        return true;
      } catch (err) {
        deps.log('error', 'failed to take a typed answer to an open question', {
          error: (err as Error).message,
          conversationId: turn.conversationId,
        });
        return false;
      }
    },
  };
}
