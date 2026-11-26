/**
 * Triggers and routines on WhatsApp (spec 2042 §5.12, omadia#1086): every turn
 * opens the kernel's routines scope with a delivery ref naming the chat, and a
 * delivery goes out to that chat through the single emitter, under the same
 * policy as every other send.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InMemorySpeakerHistoryStore, type IncomingTurn, type SemanticAnswer } from '@omadia/channel-sdk';

import { createAnswerEmitter } from '../src/emit.js';
import type { SendPolicy } from '../src/sendProviders.js';
import { createTurnHandler } from '../src/turnHandler.js';
import { createWhatsAppProactiveSend, createWhatsAppRoutineTurn } from '../src/whatsappRoutines.js';
import { boundRoute, fakeAgent, jonas, mira } from './helpers.js';

const CHANNEL_ID = '@omadia/channel-whatsapp';
const ANNA = '4917111111111@s.whatsapp.net';
const GROUP = '120363000000000000@g.us';

function turn(over: Partial<IncomingTurn> = {}): IncomingTurn {
  return {
    channelId: 'wa',
    conversationId: ANNA,
    userRef: { kind: 'whatsapp-phone', id: ANNA },
    conversationType: 'direct',
    text: 'Erinnere mich morgen an den Bericht.',
    ...over,
  };
}

function recordingEmitter() {
  const sent: Array<{ jid: string; text: string }> = [];
  const speakers: Array<SemanticAnswer['speaker']> = [];
  const inner = createAnswerEmitter({
    sendText: async (jid, text) => void sent.push({ jid, text }),
    speakerHistory: new InMemorySpeakerHistoryStore(),
  });
  return {
    sent,
    speakers,
    emitter: {
      emit: (jid: string, answer: SemanticAnswer) => {
        speakers.push(answer.speaker);
        return inner.emit(jid, answer);
      },
    },
  };
}

function proactive(policy: Partial<SendPolicy> = {}) {
  const rec = recordingEmitter();
  const send = createWhatsAppProactiveSend({
    emitter: rec.emitter,
    policy: { ignoreGroups: false, allowlist: new Set(), ...policy },
  });
  return { ...rec, send };
}

describe('routines scope per turn', () => {
  it('files the chat as a generic channel ref, never as the Conductor binding', () => {
    const seen: unknown[] = [];
    const routines = {
      beginRoutineTurn: (info: unknown) => {
        seen.push(info);
        return <T,>(fn: () => Promise<T>) => fn();
      },
    };
    createWhatsAppRoutineTurn(routines as never, CHANNEL_ID)({ userId: ANNA, jid: ANNA });
    createWhatsAppRoutineTurn(routines as never, CHANNEL_ID)({ userId: ANNA, jid: GROUP });
    assert.deepEqual(seen, [
      { userId: ANNA, channel: 'whatsapp', conductorBinding: false, conversationRef: { kind: 'channel', channelId: CHANNEL_ID, conversationId: ANNA } },
      { userId: ANNA, channel: 'whatsapp', conductorBinding: false, conversationRef: { kind: 'channel', channelId: CHANNEL_ID, conversationId: GROUP } },
    ]);
  });

  it('the agent runs inside the scope, with the same user id it sees', async () => {
    const events: unknown[] = [];
    let inside = false;
    const agent = fakeAgent([{ text: 'Mache ich.', speaker: mira }]);
    const original = agent.chat.bind(agent);
    agent.chat = (async (input: Parameters<typeof agent.chat>[0]) => {
      events.push({ inside, userId: input.userId });
      return original(input);
    }) as typeof agent.chat;
    const { emitter, sent } = recordingEmitter();
    const handler = createTurnHandler({
      route: boundRoute(agent),
      emitter,
      log: () => undefined,
      routineTurn: (info) => {
        events.push(info);
        return async (fn) => {
          inside = true;
          try {
            return await fn();
          } finally {
            inside = false;
          }
        };
      },
    });
    await handler.handle(turn({ conversationId: GROUP, conversationType: 'group' }));
    assert.deepEqual(events, [{ userId: ANNA, jid: GROUP }, { inside: true, userId: ANNA }]);
    assert.equal(sent.length, 1);
  });

  it('a rejected turn opens no scope: nobody answers, so nothing may be set', async () => {
    const opened: unknown[] = [];
    const agent = fakeAgent([{ text: 'Kein Agent.', speaker: { kind: 'system' } }]);
    const { emitter, sent } = recordingEmitter();
    const handler = createTurnHandler({
      route: () => ({ decision: 'reject', chatAgent: agent }),
      emitter,
      log: () => undefined,
      routineTurn: (info) => {
        opened.push(info);
        return (fn) => fn();
      },
    });
    await handler.handle(turn());
    assert.deepEqual(opened, []);
    assert.equal(agent.inputs.length, 1);
    assert.equal(sent.length, 1);
  });

  it('without the kernel service the turn runs exactly as before', async () => {
    const agent = fakeAgent([{ text: 'Mache ich.', speaker: mira }]);
    const { emitter, sent } = recordingEmitter();
    await createTurnHandler({ route: boundRoute(agent), emitter, log: () => undefined }).handle(turn());
    assert.equal(agent.inputs.length, 1);
    assert.equal(sent.length, 1);
  });
});

describe('proactive send', () => {
  const ref = (conversationId: string, extra: Record<string, unknown> = {}) => ({
    kind: 'channel',
    channelId: CHANNEL_ID,
    conversationId,
    ...extra,
  });

  it("delivers an agent's message through the emitter, with its speaker and a name line where needed", async () => {
    const p = proactive();
    await p.send(ref(GROUP), { text: 'Dein Bericht ist fertig.', speaker: mira });
    await p.send(ref(GROUP), { text: 'Die Rechnung ist raus.', speaker: jonas });
    assert.deepEqual(p.speakers, [mira, jonas]);
    assert.equal(p.sent.length, 2);
    assert.equal(p.sent[0]!.jid, GROUP);
    assert.match(p.sent[0]!.text, /Dein Bericht ist fertig\./);
    assert.match(p.sent[1]!.text, /Jonas/);
    assert.match(p.sent[1]!.text, /Die Rechnung ist raus\./);
  });

  it('a kernel text without a speaker goes out as a system notice', async () => {
    const p = proactive();
    await p.send(ref(ANNA), { text: 'Freigabe nötig.' });
    assert.deepEqual(p.speakers, [{ kind: 'system' }]);
    assert.deepEqual(p.sent, [{ jid: ANNA, text: 'Freigabe nötig.' }]);
  });

  it('"nothing to report" is dropped', async () => {
    const p = proactive();
    await p.send(ref(ANNA), { text: 'NO_REPLY', speaker: mira });
    assert.equal(p.sent.length, 0);
  });

  it('refuses a ref that names no WhatsApp chat', async () => {
    const p = proactive();
    for (const bad of [undefined, 'x', { kind: 'channel' }, ref('   '), ref('12345'), ref('C0123-slack')]) {
      await assert.rejects(p.send(bad, { text: 'x', speaker: mira }));
    }
    assert.equal(p.sent.length, 0);
  });

  it('refuses a ref that names a bot: this installation is one number', async () => {
    const p = proactive();
    await assert.rejects(p.send(ref(ANNA, { asChannelKey: 'whatsapp:mira' }), { text: 'x', speaker: mira }), /one number/);
    assert.equal(p.sent.length, 0);
  });

  it('refuses a group while the operator keeps the bot out of groups', async () => {
    const p = proactive({ ignoreGroups: true });
    await assert.rejects(p.send(ref(GROUP), { text: 'x', speaker: mira }), /ignore_groups/);
    assert.equal(p.sent.length, 0);
  });

  it('refuses a person the allowlist no longer names', async () => {
    const p = proactive({ allowlist: new Set(['4917222222222']) });
    await assert.rejects(p.send(ref(ANNA), { text: 'x', speaker: mira }), /allowlist/);
    await p.send(ref('4917222222222@s.whatsapp.net'), { text: 'Hallo.', speaker: mira });
    assert.equal(p.sent.length, 1);
  });
});
