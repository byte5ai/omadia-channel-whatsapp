import {
  isNoReply,
  logNoReplyDrop,
  resolveTypedInteractiveReply,
  runPacedTurn,
  type ChannelPaceProfile,
  type IncomingTurn,
  type LogLevel,
  type PaceClock,
  type PendingInteractiveStore,
  type SemanticAnswer,
} from '@omadia/channel-sdk';

import type { AnswerEmitter } from './emit.js';
import { systemAnswer } from './emit.js';
import { buildTurnOrigin, messageIdOf, routePrincipalOf, sessionScopeOf } from './inbound.js';
import { routeLocaleOf, type TurnRoute } from './routing.js';
import type { WhatsAppRoutineTurn } from './whatsappRoutines.js';

/** Why the connection did not hand a turn to an agent. */
export type TurnRefusal = 'group_roster_unavailable';

export const NO_AGENT_TEXT = 'Hier antwortet gerade kein Agent.';
export const TURN_FAILED_TEXT = 'Dabei ist ein Fehler aufgetreten. Bitte versuche es erneut.';
export const GROUP_ROSTER_UNAVAILABLE_TEXT =
  'In dieser Gruppe kann ich nicht antworten: WhatsApp liefert mir gerade die Mitgliederliste nicht, und ohne sie weiß ich nicht, wer mitliest.';

/**
 * Pace (spec 2042 §5.8): typing from the start, exactly one acknowledgement
 * after `ackThresholdMs`, no progress chatter. WhatsApp has no reply window
 * (the answer is a normal message whenever it is ready), so no `replyWindowMs`.
 * The typing presence lapses on its own after a few seconds, so it is renewed.
 */
export const WHATSAPP_PACE_PROFILE: ChannelPaceProfile = Object.freeze({
  ackThresholdMs: 8_000,
  typingIntervalMs: 8_000,
});

/** One refusal notice per conversation per window, so a busy group is not answered with notices. */
export const REFUSAL_NOTICE_WINDOW_MS = 10 * 60_000;

export interface TurnHandlerDeps {
  /** Who answers this turn: the platform's decision for the conversation and the sender's principal. */
  readonly route: (turn: IncomingTurn, principal: string) => TurnRoute;
  readonly emitter: AnswerEmitter;
  /** The same store the emitter records into: a typed "2" answers the question last shown (criterion 30). */
  readonly pendingInteractives?: PendingInteractiveStore;
  readonly log: (level: LogLevel, message: string, context?: Record<string, unknown>) => void;
  /** Show the "composing" presence in a chat. Presence, not a message. */
  readonly sendTyping?: (jid: string) => Promise<void>;
  readonly pace?: ChannelPaceProfile;
  /**
   * Opens the kernel's routines scope for one turn (triggers, `manage_routine`).
   * Absent when the kernel publishes no `routinesIntegration`: turns run as before.
   */
  readonly routineTurn?: WhatsAppRoutineTurn;
  /** Timer seam for tests. */
  readonly clock?: PaceClock;
  readonly now?: () => number;
}

export interface TurnHandler {
  handle(turn: IncomingTurn): Promise<void>;
  refuse(turn: IncomingTurn, reason: TurnRefusal): Promise<void>;
}

/**
 * Drives one turn and ships the answer back through the single emitter. The
 * text goes to the agent the platform's resolver returned unchanged: `/agent`,
 * `/agent <Name>` and `/agents` are carried out by that agent, and its reply
 * arrives as a `system` notice in the `SemanticAnswer`.
 *
 * - `bound`: the agent answers. The one pace acknowledgement goes out under the
 *   agent's own speaker (`route.speaker`, known before the answer), in its name.
 * - `reject`: nobody answers. The resolver's agent still receives the text (it
 *   handles `/agent`), but whatever comes back is posted as `system`: a reject
 *   never produces an agent's answer. Where the platform gave no agent, the
 *   `notice` is posted directly as `system`.
 * - An answer without a speaker is not sent (INV-4); the user gets the
 *   `system` failure text instead (fail-closed, see `MissingSpeakerError`).
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

  /** The notice of a reject, as the one `system` message it is. */
  function rejectAnswer(route: TurnRoute): SemanticAnswer {
    return {
      text: route.notice?.text ?? NO_AGENT_TEXT,
      speaker: { kind: 'system' },
      ...(route.notice ? { systemNotice: route.notice } : {}),
    };
  }

  return {
    async handle(turn) {
      try {
        const jid = turn.conversationId;
        const origin = buildTurnOrigin(turn, messageIdOf(turn));
        const route = deps.route(turn, routePrincipalOf(turn, origin));
        const agent = route.chatAgent;
        if (!agent) {
          if (route.decision === 'reject') {
            await deps.emitter.emit(jid, rejectAnswer(route));
            return;
          }
          throw new Error('the platform bound this turn to an agent but returned none');
        }
        // The agent's own speaker is known up front only for a bound turn.
        const ackSpeaker = route.decision === 'bound' ? route.speaker : undefined;
        const userMessage = deps.pendingInteractives
          ? resolveTypedInteractiveReply(deps.pendingInteractives, jid, turn.text).text
          : turn.text;
        const userId = turn.userRef.id;
        const chat = () => agent.chat({ userMessage, sessionScope: sessionScopeOf(jid), userId, origin });
        // The routines scope wraps the whole turn: who asks, and where a
        // trigger or routine the agent sets now delivers later.
        const routineTurn = deps.routineTurn;
        const runTurn = routineTurn && userId ? () => routineTurn({ userId, jid })(chat) : chat;
        const { result: answer } = await runPacedTurn(
          runTurn,
          deps.pace ?? WHATSAPP_PACE_PROFILE,
          {
            ...(deps.sendTyping ? { sendTyping: () => deps.sendTyping?.(jid) } : {}),
            // One acknowledgement, in the routed agent's name (its words from
            // the pace template); `system` only where no agent is known yet.
            sendAck: (text) =>
              emitSafely(jid, { text, speaker: ackSpeaker ?? { kind: 'system' } }),
            onHookError: (hook, error) =>
              deps.log('warn', 'WhatsApp pace hook failed', { hook, error: (error as Error).message }),
          },
          {
            ...(deps.clock ? { clock: deps.clock } : {}),
            ...(routeLocaleOf(turn) ? { locale: routeLocaleOf(turn) as string } : {}),
          },
        );
        if (isNoReply(answer)) {
          logNoReplyDrop(turn.channelId, { conversationId: turn.conversationId });
          return;
        }
        if (route.decision === 'reject' && answer.speaker?.kind !== 'system') {
          deps.log('error', 'a rejected turn produced a non-system answer; posting the notice instead', {
            conversationId: jid,
          });
          await deps.emitter.emit(jid, rejectAnswer(route));
          return;
        }
        await deps.emitter.emit(jid, answer);
      } catch (err) {
        deps.log('error', 'failed to handle WhatsApp turn', {
          error: (err as Error).message,
          errorName: (err as Error).name,
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
