import {
  admitDecorations,
  renderPlainAnswer,
  type DecorationRefusal,
  type PendingInteractiveStore,
  type SemanticAnswer,
  type SpeakerHistoryStore,
} from '@omadia/channel-sdk';

import { attachmentLines, mdToWhatsApp } from './renderer.js';

/** The channel type this plugin declares to the kernel registries. */
export const WHATSAPP_CHANNEL_TYPE = 'whatsapp';

/**
 * Every decoration this channel may put above or below an answer (spec 2042
 * §5.14, decoration registry #2086). A plain-text channel renders exactly one:
 * the AI disclosure line, which is already part of `answer.text` according to
 * the operator's frequency setting (#2087). The 👀 receipt reaction, follow-up
 * lists, disclaimers, verifier badges and consulted footers are not declared,
 * so they are not rendered. Pace is shown by the typing indicator, which is
 * presence, not a message element.
 */
export const WHATSAPP_DECORATIONS: readonly { readonly id: string }[] = Object.freeze([
  { id: 'ai_disclosure_line' },
]);

/**
 * A message without a speaker is never sent (INV-4: a path that cannot name its
 * speaker cannot emit). Fail-closed on purpose: sending it anyway would put
 * words in the chat that nobody answers for, and a made-up `system` label would
 * be a claim the plugin cannot back. The turn handler turns the refusal into a
 * `system` failure text, so the user is never left in silence.
 */
export class MissingSpeakerError extends Error {
  constructor() {
    super('answer carries no speaker (agent or system); refusing to send it');
    this.name = 'MissingSpeakerError';
  }
}

/** A message the plugin itself originates: it speaks as `system`, never as an agent. */
export function systemAnswer(text: string): SemanticAnswer {
  return { text, speaker: { kind: 'system' } };
}

/**
 * The plain WhatsApp text of one answer, via the SDK reference renderer.
 * WhatsApp has no per-agent identity in this plugin (one linked number), so
 * `nativeIdentity` is false: the name line appears only where the speaker
 * would otherwise be unclear (several agents, or the first answer after a
 * change). Records the speaker in `speakerHistory`.
 */
export function renderWhatsAppText(
  answer: SemanticAnswer,
  conversationKey: string,
  speakerHistory: SpeakerHistoryStore,
  pendingInteractives?: PendingInteractiveStore,
): string {
  const plain = renderPlainAnswer(answer, {
    nativeIdentity: false,
    conversationKey,
    speakerHistory,
    ...(pendingInteractives ? { pendingInteractives } : {}),
  });
  // A system notice is its own text; attachments belong to agent answers.
  const links = answer.speaker?.kind === 'system' ? '' : attachmentLines(answer.attachments);
  return mdToWhatsApp([plain, links].filter((part) => part.trim().length > 0).join('\n\n')).trim();
}

export interface EmitterDeps {
  /** The one raw send primitive (`WhatsAppConnection.sendText`); resolves to the WhatsApp message id when known. */
  readonly sendText: (jid: string, text: string) => Promise<string | undefined | void>;
  readonly speakerHistory: SpeakerHistoryStore;
  /**
   * Where a choice/topic/slots question shown as numbered text is kept, so the
   * turn handler can turn the person's typed "2" into the option it names
   * (spec 2042 §6 criterion 30).
   */
  readonly pendingInteractives?: PendingInteractiveStore;
  readonly onDecorationRefused?: (refusal: DecorationRefusal) => void;
}

export interface AnswerEmitter {
  /**
   * Render and send one answer; resolves to the WhatsApp message id when known.
   * Throws {@link MissingSpeakerError} without a speaker.
   */
  emit(jid: string, answer: SemanticAnswer): Promise<string | undefined>;
}

/**
 * The single outbound path of this plugin. Every user-visible WhatsApp message
 * (agent answers, plugin-originated notices, error texts) passes through
 * `emit`, so every message carries a speaker and none carries an undeclared
 * decoration. `emitter.test.ts` fails when a second path to the socket appears.
 */
export function createAnswerEmitter(deps: EmitterDeps): AnswerEmitter {
  // Fail-closed at construction: the declared decorations must be admitted for this channel.
  const { refused } = admitDecorations(WHATSAPP_CHANNEL_TYPE, WHATSAPP_DECORATIONS, deps.onDecorationRefused);
  if (refused.length > 0) {
    throw new Error(
      `WhatsApp declares decorations the registry does not admit: ${refused.map((r) => r.id).join(', ')}`,
    );
  }
  return {
    async emit(jid, answer) {
      if (!answer.speaker) throw new MissingSpeakerError();
      const text = renderWhatsAppText(answer, jid, deps.speakerHistory, deps.pendingInteractives);
      if (text.length === 0) return undefined;
      return (await deps.sendText(jid, text)) ?? undefined;
    },
  };
}
