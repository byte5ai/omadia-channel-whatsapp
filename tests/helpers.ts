import type { ChatAgent, PaceClock, SemanticAnswer } from '@omadia/channel-sdk';
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

/** A manual clock: timers fire only when the test advances time. */
export function manualClock() {
  let now = 0;
  const timers: { at: number; fn: () => void; every?: number; id: number; done?: boolean }[] = [];
  let nextId = 1;
  const clock: PaceClock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const t = { at: now + ms, fn, id: nextId++ };
      timers.push(t);
      return t.id;
    },
    clearTimeout: (h) => {
      const t = timers.find((x) => x.id === h);
      if (t) t.done = true;
    },
    setInterval: (fn, ms) => {
      const t = { at: now + ms, fn, every: ms, id: nextId++ };
      timers.push(t);
      return t.id;
    },
    clearInterval: (h) => {
      const t = timers.find((x) => x.id === h);
      if (t) t.done = true;
    },
  };
  const advance = async (ms: number): Promise<void> => {
    const target = now + ms;
    for (;;) {
      const due = timers.filter((t) => !t.done && t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      now = due.at;
      if (due.every !== undefined) due.at += due.every;
      else due.done = true;
      due.fn();
      await Promise.resolve();
    }
    now = target;
    await Promise.resolve();
  };
  return { clock, advance };
}

/** A ChatAgent whose answer is released by the test. */
export function deferredAgent(): { agent: ChatAgent; release: (a: SemanticAnswer) => void; fail: (e: Error) => void } {
  let release: (a: SemanticAnswer) => void = () => undefined;
  let fail: (e: Error) => void = () => undefined;
  const agent = {
    chat: () =>
      new Promise<SemanticAnswer>((resolve, reject) => {
        release = resolve;
        fail = reject;
      }),
  } as unknown as ChatAgent;
  return { agent, release: (a) => release(a), fail: (e) => fail(e) };
}
