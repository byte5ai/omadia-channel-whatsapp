/**
 * Triggers and routines on WhatsApp (spec 2042 §5.12, omadia#1086).
 *
 * Two halves of one delivery path:
 *
 *  - Every turn opens the kernel's routines scope (`beginRoutineTurn`): who
 *    the person is and where a later delivery goes. Only then does the kernel
 *    offer the agent its trigger tools and `manage_routine`. The delivery ref
 *    is the generic channel shape naming the chat JID. This installation is
 *    one number, so the ref never names a bot (`asChannelKey`).
 *  - The proactive send (`publishProactiveSend('whatsapp', …)`) delivers a
 *    trigger's or routine's message to that chat through the single emitter:
 *    an agent's message carries its speaker (the name line where it is
 *    needed), a kernel text speaks as `system`. A chat the operator's policy
 *    no longer allows (groups ignored, allowlist) is refused, never sent.
 */

import { isNoReply } from '@omadia/channel-sdk';
import type { RoutinesIntegration, RoutineTurnRunner } from '@omadia/plugin-api';

import { WHATSAPP_CHANNEL_TYPE, systemAnswer, type AnswerEmitter } from './emit.js';
import { conversationTarget, type SendPolicy } from './sendProviders.js';

/** The channel the routines file a WhatsApp turn under, and the sender's key. */
export const WHATSAPP_ROUTINE_CHANNEL = WHATSAPP_CHANNEL_TYPE;

/** The kernel's routines surface (`routinesIntegration@1`, optional_requires). */
export const ROUTINES_INTEGRATION_SERVICE = 'routinesIntegration';

type ProactiveSend = Parameters<RoutinesIntegration['publishProactiveSend']>[1];

/** The delivery ref a WhatsApp turn files: the generic channel shape. */
export interface WhatsAppDeliveryRef {
  readonly kind: 'channel';
  readonly channelId: string;
  readonly conversationId: string;
}

/** Opens one turn's routines scope; the runner wraps the turn body. */
export type WhatsAppRoutineTurn = (info: { readonly userId: string; readonly jid: string }) => RoutineTurnRunner;

export function createWhatsAppRoutineTurn(
  routines: Pick<RoutinesIntegration, 'beginRoutineTurn'>,
  channelId: string,
): WhatsAppRoutineTurn {
  return ({ userId, jid }) => {
    const conversationRef: WhatsAppDeliveryRef = { kind: 'channel', channelId, conversationId: jid };
    // Triggers and routines only: a group, and a linked number shared by every
    // agent, is not where the person's Conductor reminders go (as Telegram).
    return routines.beginRoutineTurn({
      userId,
      channel: WHATSAPP_ROUTINE_CHANNEL,
      conversationRef,
      conductorBinding: false,
    });
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The chat a delivery ref names, or undefined when it names none. */
export function parseDeliveryRef(ref: unknown): { conversationId: string; asChannelKey: string | undefined } | undefined {
  if (!isRecord(ref)) return undefined;
  const conversationId = ref['conversationId'];
  if (typeof conversationId !== 'string' || conversationId.trim() === '') return undefined;
  const raw = ref['asChannelKey'];
  const asChannelKey = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;
  return { conversationId, asChannelKey };
}

export interface WhatsAppProactiveSendDeps {
  readonly emitter: Pick<AnswerEmitter, 'emit'>;
  readonly policy: SendPolicy;
}

export function createWhatsAppProactiveSend(deps: WhatsAppProactiveSendDeps): ProactiveSend {
  return async (conversationRef, message) => {
    const ref = parseDeliveryRef(conversationRef);
    if (!ref) throw new Error('not a WhatsApp delivery: the ref names no WhatsApp chat');
    if (ref.asChannelKey !== undefined) {
      throw new Error(
        `this WhatsApp installation is one number and runs no bot '${ref.asChannelKey}'; nothing was sent`,
      );
    }
    const target = conversationTarget(ref.conversationId, deps.policy);
    if ('refusal' in target) throw new Error(`${target.refusal.message}; nothing was sent`);
    // "Nothing to report this run": dropped, the run history keeps the turn.
    if (isNoReply(message)) return;
    if (message.speaker?.kind === 'agent') {
      await deps.emitter.emit(target.jid, { text: message.text, speaker: message.speaker });
      return;
    }
    // Kernel texts (an approval request, a reminder) name no agent.
    await deps.emitter.emit(target.jid, systemAnswer(message.text));
  };
}
