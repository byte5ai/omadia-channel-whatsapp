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

/** How long a turn waits for the kernel to say whether it took a message as a typed answer. */
export const REPORT_TIMEOUT_MS = 1_500;

export interface MessageEventDeps {
  readonly channelId: string;
  /** `core.emitConversationMessage`; absent on a kernel before #2043. */
  readonly emit: ((event: ConversationMessageEvent) => void) | undefined;
  /**
   * `core.reportConversationMessage`: like `emit`, but the kernel says whether
   * it took the message as the typed answer to an open question. Absent on an
   * older kernel: `emit` and the turn runs as before.
   */
  readonly report: ((event: ConversationMessageEvent) => Promise<{ answeredCard: boolean }>) | undefined;
  /** Upper bound of the wait for `report`; default {@link REPORT_TIMEOUT_MS}. */
  readonly reportTimeoutMs?: number;
  /** `core.conversationDelivery` / `isAllMessagesSubscribed`, already feature-detected; absent = ask nobody. */
  readonly delivery: ((conversationId: string, channelKey: string) => DeliveryMode) | undefined;
  readonly installationKey: () => string | undefined;
  readonly log: (level: LogLevel, message: string, context?: Record<string, unknown>) => void;
  readonly now?: () => Date;
}

/** What became of a reported message: the delivery mode that applied, and whether the kernel consumed it as an answer. */
export interface CreatedOutcome {
  readonly mode: DeliveryMode;
  /** `true`: the kernel stored it as a `card_answer`, so the channel starts NO turn. Unknown counts as `false`. */
  readonly answeredCard: boolean;
}

export interface MessageEvents {
  /**
   * Tell the kernel about one inbound human message (`kind: 'created'`) with
   * its platform-stated author, the WhatsApp id of the message it quotes
   * (`replyToMessageId`) and whether it addresses the bot (`addressedToBot`).
   * An addressed message that would start a turn is reported with
   * `reportConversationMessage` (bounded by a short timeout), so a typed answer
   * to a poll starts no turn. Never throws and never delays the turn for long.
   * `mode` lets the caller leave the turn to the engine on `all`.
   */
  created(turn: IncomingTurn, addressing: MessageAddressing | undefined): Promise<CreatedOutcome>;
}

/** `promise`, or `undefined` once `ms` have passed. The timer never outlives the race. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function occurredAt(turn: IncomingTurn, now: () => Date): string {
  const stamp = (turn.rawEvent as { messageTimestamp?: unknown } | undefined)?.messageTimestamp;
  const seconds = typeof stamp === 'number' ? stamp : Number(stamp);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : now().toISOString();
}

export function createMessageEvents(deps: MessageEventDeps): MessageEvents {
  const now = deps.now ?? (() => new Date());
  const timeoutMs = deps.reportTimeoutMs ?? REPORT_TIMEOUT_MS;
  const unreported = (mode: DeliveryMode): CreatedOutcome => ({ mode, answeredCard: false });

  /** Ask the kernel whether it consumed the message; a timeout or an error means "no". */
  async function reported(event: ConversationMessageEvent, conversationId: string): Promise<boolean> {
    if (!deps.report) return false;
    try {
      const answer = await withTimeout(deps.report(event), timeoutMs);
      if (answer === undefined) {
        deps.log('warn', 'the kernel did not answer a message report in time; the turn starts', { conversationId });
        return false;
      }
      return answer.answeredCard === true;
    } catch (err) {
      deps.log('warn', 'could not report a conversation message; the turn starts', {
        error: (err as Error).message,
        conversationId,
      });
      return false;
    }
  }

  return {
    async created(turn, addressing) {
      const key = deps.installationKey();
      if (!deps.emit || !key) return unreported('none');
      try {
        // Without an answer from the kernel only what addresses the bot is handed over.
        const mode = deps.delivery?.(turn.conversationId, key) ?? 'addressed';
        const addressed = isAddressedToBot(addressing);
        if (mode === 'none' || (mode === 'addressed' && !addressed)) return unreported(mode);
        const messageId = messageIdOf(turn);
        // No id to name the message by: nothing to emit, so the turn must not be left to the engine.
        if (!messageId) return unreported('addressed');
        const quoted = turn.metadata?.['quotedMessageId'];
        const event: ConversationMessageEvent = {
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
        };
        // Where the channel starts a turn for this message (addressed, not `all`),
        // the kernel says whether the message was a typed answer instead.
        if (mode === 'addressed' && addressed && deps.report) {
          return { mode, answeredCard: await reported(event, turn.conversationId) };
        }
        deps.emit(event);
        return unreported(mode);
      } catch (err) {
        // A failed emit must never break the message that carried it.
        deps.log('warn', 'could not emit a conversation message event', {
          error: (err as Error).message,
          conversationId: turn.conversationId,
        });
        return unreported('none');
      }
    },
  };
}

/**
 * One addressed message: report it to the kernel first, then start the turn
 * unless the kernel took the message as a typed answer (`answeredCard`: no pace
 * acknowledgement, no agent reply) or reads the conversation for a facilitation
 * (`all`: the engine drives). Resolves to whether a turn was started.
 */
export async function handleAddressed(
  events: MessageEvents,
  turn: IncomingTurn,
  addressing: MessageAddressing,
  startTurn: () => Promise<void>,
): Promise<boolean> {
  const { mode, answeredCard } = await events.created(turn, addressing);
  if (mode === 'all' || answeredCard) return false;
  await startTurn();
  return true;
}
