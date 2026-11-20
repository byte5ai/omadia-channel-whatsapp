import type { ConversationMessageEvent, IncomingTurn, LogLevel } from '@omadia/channel-sdk';

import { WHATSAPP_CHANNEL_TYPE } from './emit.js';
import type { OwnIdentity } from './groupAddressing.js';
import { messageIdOf } from './inbound.js';

/** How a message reached the bot: the reason it counts as addressed to it. */
export type MessageAddressing = 'direct' | 'mention' | 'reply_to_bot' | 'agent_command';

/** What the kernel wants of a conversation: every human message, only what addresses the bot, or nothing. */
export type DeliveryMode = 'all' | 'addressed' | 'none';

/**
 * The identity key of this installation in message events: the linked account,
 * in the form `whatsapp:<jid>`. The kernel has no per-agent identity key for
 * WhatsApp (one number serves every agent), so this is the only key the plugin
 * can state; it is undefined until the account is linked.
 */
export function whatsAppInstallationKey(own: OwnIdentity): string | undefined {
  const id = own.jid || own.lid;
  return id ? `${WHATSAPP_CHANNEL_TYPE}:${id}`.toLowerCase() : undefined;
}

/** `addressedToBot` of a message: any way of reaching the bot counts; an unaddressed group message does not. */
export function isAddressedToBot(addressing: MessageAddressing | undefined): boolean {
  return addressing !== undefined;
}

export interface MessageEventDeps {
  readonly channelId: string;
  /** `core.emitConversationMessage`; absent on a kernel before #2043. */
  readonly emit: ((event: ConversationMessageEvent) => void) | undefined;
  /** `core.conversationDelivery` / `isAllMessagesSubscribed`, already feature-detected; absent = ask nobody. */
  readonly delivery: ((conversationId: string, channelKey: string) => DeliveryMode) | undefined;
  readonly installationKey: () => string | undefined;
  readonly log: (level: LogLevel, message: string, context?: Record<string, unknown>) => void;
  readonly now?: () => Date;
}

export interface MessageEvents {
  /**
   * Tell the kernel about one inbound human message (`kind: 'created'`) with
   * its platform-stated author, the WhatsApp id of the message it quotes
   * (`replyToMessageId`) and whether it addresses the bot (`addressedToBot`).
   * Emitting is not a turn and never fails the caller. Returns the delivery
   * mode that applied, so the caller can leave the turn to the engine on `all`.
   */
  created(turn: IncomingTurn, addressing: MessageAddressing | undefined): DeliveryMode;
}

function occurredAt(turn: IncomingTurn, now: () => Date): string {
  const stamp = (turn.rawEvent as { messageTimestamp?: unknown } | undefined)?.messageTimestamp;
  const seconds = typeof stamp === 'number' ? stamp : Number(stamp);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : now().toISOString();
}

export function createMessageEvents(deps: MessageEventDeps): MessageEvents {
  const now = deps.now ?? (() => new Date());
  return {
    created(turn, addressing) {
      const key = deps.installationKey();
      if (!deps.emit || !key) return 'none';
      try {
        // Without an answer from the kernel only what addresses the bot is handed over.
        const mode = deps.delivery?.(turn.conversationId, key) ?? 'addressed';
        const addressed = isAddressedToBot(addressing);
        if (mode === 'none' || (mode === 'addressed' && !addressed)) return mode;
        const messageId = messageIdOf(turn);
        // No id to name the message by: nothing to emit, so the turn must not be left to the engine.
        if (!messageId) return 'addressed';
        const quoted = turn.metadata?.['quotedMessageId'];
        deps.emit({
          channelId: deps.channelId,
          channelType: WHATSAPP_CHANNEL_TYPE,
          conversationId: turn.conversationId,
          ...(turn.conversationType ? { conversationType: turn.conversationType } : {}),
          receivedByChannelKey: key,
          messageId,
          revision: 0,
          kind: 'created',
          author: turn.userRef,
          text: turn.text,
          ...(typeof quoted === 'string' && quoted.length > 0 ? { replyToMessageId: quoted, quoted: true } : {}),
          addressedToBot: addressed,
          occurredAt: occurredAt(turn, now),
          rawEvent: turn.rawEvent,
        });
        return mode;
      } catch (err) {
        // A failed emit must never break the message that carried it.
        deps.log('warn', 'could not emit a conversation message event', {
          error: (err as Error).message,
          conversationId: turn.conversationId,
        });
        return 'none';
      }
    },
  };
}
