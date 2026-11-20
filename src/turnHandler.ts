import {
  isNoReply,
  logNoReplyDrop,
  type ChatAgent,
  type IncomingTurn,
  type LogLevel,
  type SemanticAnswer,
} from '@omadia/channel-sdk';

import type { AnswerEmitter } from './emit.js';
import { systemAnswer } from './emit.js';
import { buildTurnOrigin, sessionScopeOf } from './inbound.js';

/** Why the connection did not hand a turn to an agent. */
export type TurnRefusal = 'group_roster_unavailable';

export const TURN_FAILED_TEXT = 'Dabei ist ein Fehler aufgetreten. Bitte versuche es erneut.';
export const GROUP_ROSTER_UNAVAILABLE_TEXT =
  'In dieser Gruppe kann ich nicht antworten: WhatsApp liefert mir gerade die Mitgliederliste nicht, und ohne sie weiß ich nicht, wer mitliest.';

/** One refusal notice per conversation per window, so a busy group is not answered with notices. */
export const REFUSAL_NOTICE_WINDOW_MS = 10 * 60_000;

export interface TurnHandlerDeps {
  /** The agent that serves this turn (operator binding, platform fallback, or default). */
  readonly agentFor: (turn: IncomingTurn) => ChatAgent;
  readonly emitter: AnswerEmitter;
  readonly log: (level: LogLevel, message: string, context?: Record<string, unknown>) => void;
  readonly now?: () => number;
}

export interface TurnHandler {
  handle(turn: IncomingTurn): Promise<void>;
  refuse(turn: IncomingTurn, reason: TurnRefusal): Promise<void>;
}

/**
 * Drives one orchestrator turn and ships the answer back through the single
 * emitter. The text goes to the kernel unchanged: `/agent …` is parsed by the
 * management layer there, and its reply arrives as a `system` notice in the
 * `SemanticAnswer`.
 */
export function createTurnHandler(deps: TurnHandlerDeps): TurnHandler {
  const now = deps.now ?? Date.now;
  const lastRefusal = new Map<string, number>();

  async function emitSafely(jid: string, answer: SemanticAnswer): Promise<void> {
    try {
      await deps.emitter.emit(jid, answer);
    } catch (err) {
      deps.log('error', 'failed to send WhatsApp message', {
        error: (err as Error).message,
        conversationId: jid,
      });
    }
  }

  return {
    async handle(turn) {
      try {
        const answer = await deps.agentFor(turn).chat({
          userMessage: turn.text,
          sessionScope: sessionScopeOf(turn.conversationId),
          userId: turn.userRef.id,
          origin: buildTurnOrigin(turn, messageIdOf(turn)),
        });
        if (isNoReply(answer)) {
          logNoReplyDrop(turn.channelId, { conversationId: turn.conversationId });
          return;
        }
        await deps.emitter.emit(turn.conversationId, answer);
      } catch (err) {
        deps.log('error', 'failed to handle WhatsApp turn', {
          error: (err as Error).message,
          conversationId: turn.conversationId,
        });
        // Fail loud (INV-7): the user is told, as the system, never as an agent.
        await emitSafely(turn.conversationId, systemAnswer(TURN_FAILED_TEXT));
      }
    },

    async refuse(turn, reason) {
      deps.log('warn', 'WhatsApp turn refused', { reason, conversationId: turn.conversationId });
      const last = lastRefusal.get(turn.conversationId);
      if (last !== undefined && now() - last < REFUSAL_NOTICE_WINDOW_MS) return;
      lastRefusal.set(turn.conversationId, now());
      await emitSafely(turn.conversationId, systemAnswer(GROUP_ROSTER_UNAVAILABLE_TEXT));
    },
  };
}

function messageIdOf(turn: IncomingTurn): string | undefined {
  const key = (turn.rawEvent as { key?: { id?: string | null } } | undefined)?.key;
  return key?.id ?? undefined;
}
