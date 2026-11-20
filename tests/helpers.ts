import type { ChatAgent, SemanticAnswer } from '@omadia/channel-sdk';
import type { WAMessage } from '@whiskeysockets/baileys';

export const OWN = { jid: '4915100000000@s.whatsapp.net', lid: '99887766@lid' } as const;

export const mira = { kind: 'agent', agentId: 'a-mira', slug: 'mira', displayName: 'Mira' } as const;
export const jonas = { kind: 'agent', agentId: 'a-jonas', slug: 'jonas', displayName: 'Jonas' } as const;

/** A ChatAgent that returns the queued answers and records the inputs it saw. */
export function fakeAgent(answers: SemanticAnswer[]): ChatAgent & { inputs: Array<Record<string, unknown>> } {
  const inputs: Array<Record<string, unknown>> = [];
  const queue = [...answers];
  return {
    inputs,
    async chat(input) {
      inputs.push(input as unknown as Record<string, unknown>);
      const next = queue.shift();
      if (!next) throw new Error('no answer queued');
      return next;
    },
  } as unknown as ChatAgent & { inputs: Array<Record<string, unknown>> };
}

export function textMessage(args: {
  jid: string;
  text: string;
  participant?: string;
  mentioned?: string[];
  quotedParticipant?: string;
  id?: string;
}): WAMessage {
  const contextInfo =
    args.mentioned || args.quotedParticipant
      ? {
          ...(args.mentioned ? { mentionedJid: args.mentioned } : {}),
          ...(args.quotedParticipant
            ? { quotedMessage: { conversation: 'earlier' }, participant: args.quotedParticipant }
            : {}),
        }
      : undefined;
  return {
    key: {
      remoteJid: args.jid,
      id: args.id ?? 'MSG1',
      fromMe: false,
      ...(args.participant ? { participant: args.participant } : {}),
    },
    pushName: 'Anna',
    message: contextInfo
      ? { extendedTextMessage: { text: args.text, contextInfo } }
      : { conversation: args.text },
  } as unknown as WAMessage;
}
