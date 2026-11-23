import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InMemoryPendingInteractiveStore, InMemorySpeakerHistoryStore, paceAckText, type IncomingTurn, type SemanticAnswer } from '@omadia/channel-sdk';

import { createAnswerEmitter } from '../src/emit.js';
import { TURN_FAILED_TEXT, WHATSAPP_PACE_PROFILE, createTurnHandler } from '../src/turnHandler.js';
import { boundRoute, deferredAgent, fakeAgent, manualClock, mira } from './helpers.js';

const JID = '4917@s.whatsapp.net';
const turn: IncomingTurn = {
  channelId: 'wa',
  conversationId: JID,
  userRef: { kind: 'whatsapp-phone', id: JID },
  conversationType: 'direct',
  text: 'Erstelle den Bericht',
};

function setup(route: Parameters<typeof createTurnHandler>[0]['route']) {
  const sent: string[] = [];
  const typing: string[] = [];
  const speakers: unknown[] = [];
  const { clock, advance } = manualClock();
  const inner = createAnswerEmitter({
    sendText: async (_j, t) => void sent.push(t),
    speakerHistory: new InMemorySpeakerHistoryStore(),
  });
  const handler = createTurnHandler({
    route,
    emitter: {
      emit: (jid, answer) => {
        speakers.push(answer.speaker);
        return inner.emit(jid, answer);
      },
    },
    sendTyping: async (jid) => void typing.push(jid),
    clock,
    log: () => {},
  });
  return { handler, sent, typing, speakers, advance };
}

describe('pace (spec 5.8): typing, one acknowledgement, no chatter', () => {
  it('has no reply window: a late answer is a normal message', () => {
    assert.equal(WHATSAPP_PACE_PROFILE.replyWindowMs, undefined);
  });

  it('a fast answer: typing shown, no acknowledgement', async () => {
    const { handler, sent, typing } = setup(boundRoute(fakeAgent([{ text: 'Fertig.', speaker: mira }])));
    await handler.handle(turn);
    assert.deepEqual(typing, [JID]);
    assert.deepEqual(sent, ['Fertig.']);
  });

  it('slow work: typing renewed, exactly one acknowledgement in the routed agent\'s name, then the answer', async () => {
    const d = deferredAgent();
    const { handler, sent, typing, speakers, advance } = setup(boundRoute(d.agent, mira));
    const running = handler.handle(turn);
    await advance(7_999);
    assert.equal(sent.length, 0);
    await advance(2);
    await advance(120_000);
    assert.equal(sent.length, 1, 'one acknowledgement, no progress chatter');
    assert.ok(sent[0]!.includes(paceAckText(undefined)), 'the pace template, no model call');
    assert.ok(typing.length > 3, `typing renewed (${String(typing.length)}x)`);
    d.release({ text: 'Der Bericht liegt vor.', speaker: mira });
    await running;
    assert.equal(sent.length, 2);
    assert.equal(sent[1], 'Der Bericht liegt vor.', 'the name line was already shown with the acknowledgement');
    assert.deepEqual(speakers, [mira, mira], 'the acknowledgement is the agent\'s, not the system\'s');
  });

  it('the acknowledgement is system text only where the routed agent is not known up front', async () => {
    const d = deferredAgent();
    const { handler, sent, speakers, advance } = setup(boundRoute(d.agent, null));
    const running = handler.handle(turn);
    await advance(9_000);
    assert.deepEqual(sent, [paceAckText(undefined)]);
    assert.deepEqual(speakers, [{ kind: 'system' }]);
    d.release({ text: 'ok', speaker: mira });
    await running;
  });

  it('typing stops once the turn is over', async () => {
    const d = deferredAgent();
    const { handler, typing, advance } = setup(boundRoute(d.agent));
    const running = handler.handle(turn);
    d.release({ text: 'ok', speaker: mira });
    await running;
    const before = typing.length;
    await advance(60_000);
    assert.equal(typing.length, before);
  });

  it('work that fails after the acknowledgement ends in a system error text, not silence', async () => {
    const d = deferredAgent();
    const { handler, sent, advance } = setup(boundRoute(d.agent));
    const running = handler.handle(turn);
    await advance(9_000);
    d.fail(new Error('agent failed'));
    await running;
    assert.equal(sent.length, 2);
    assert.ok(sent[0]!.includes(paceAckText(undefined)));
    assert.equal(sent[1], TURN_FAILED_TEXT, 'the failure is the system\'s, never the agent\'s');
  });
});

describe('a typed "2" to a numbered question (spec 2042 criterion 30)', () => {
  it('reaches the agent as the option it names, once; a topic and a slot are picked the same way', async () => {
    const pendingInteractives = new InMemoryPendingInteractiveStore();
    const sent: string[] = [];
    const emitter = createAnswerEmitter({
      sendText: async (_j, t) => void sent.push(t),
      speakerHistory: new InMemorySpeakerHistoryStore(),
      pendingInteractives,
    });
    const messages: string[] = [];
    const answers: SemanticAnswer[] = [
      {
        text: 'Welche Variante?',
        speaker: mira,
        interactive: { kind: 'choice', question: 'Welche?', options: [{ label: 'A', value: 'variante-a' }, { label: 'B', value: 'variante-b' }] },
      } as SemanticAnswer,
      { text: 'Gut.', speaker: mira } as SemanticAnswer,
      {
        text: 'Welche Firma?',
        speaker: mira,
        interactive: { kind: 'topic', question: 'Firma?', topics: [{ label: 'ACME GmbH', value: 'acme' }, { label: 'ACME AG', value: 'acme-ag' }] },
      } as SemanticAnswer,
      { text: 'Ok.', speaker: mira } as SemanticAnswer,
      {
        text: 'Wann?',
        speaker: mira,
        interactive: { kind: 'slots', question: 'Termin?', slots: [{ slotId: 's1', start: '2026-12-01T09:00:00Z', end: '2026-12-01T09:30:00Z', timeZone: 'Europe/Berlin', label: 'Di 10:00', confidence: 0.9 }] },
      } as SemanticAnswer,
      { text: 'Gebucht.', speaker: mira } as SemanticAnswer,
    ];
    const agent = {
      chat: async (input: { userMessage: string }) => {
        messages.push(input.userMessage);
        return answers.shift() as SemanticAnswer;
      },
    };
    const handler = createTurnHandler({ route: boundRoute(agent as never, mira), emitter, pendingInteractives, log: () => {} });
    const say = (text: string) => handler.handle({ ...turn, text });

    await say('hilf mir');
    assert.match(sent[0] ?? '', /1\) A\n2\) B/);
    await say('2');
    await say('2'); // the question is spent: just a "2" (the agent answers with a topic question)
    await say('2');
    await say('noch was'); // the agent answers with a slot question
    await say('1');
    assert.deepEqual(messages.slice(0, 3), ['hilf mir', 'variante-b', '2']);
    assert.equal(messages[3], 'acme-ag');
    assert.equal(messages[4], 'noch was');
    assert.match(messages[5] ?? '', /slotId="s1"/);
  });
});
