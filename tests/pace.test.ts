import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InMemorySpeakerHistoryStore, paceAckText, type IncomingTurn } from '@omadia/channel-sdk';

import { createAnswerEmitter } from '../src/emit.js';
import { TURN_FAILED_TEXT, WHATSAPP_PACE_PROFILE, createTurnHandler } from '../src/turnHandler.js';
import { deferredAgent, fakeAgent, manualClock, mira } from './helpers.js';

const JID = '4917@s.whatsapp.net';
const turn: IncomingTurn = {
  channelId: 'wa',
  conversationId: JID,
  userRef: { kind: 'whatsapp-phone', id: JID },
  conversationType: 'direct',
  text: 'Erstelle den Bericht',
};

function setup(agent: Parameters<typeof createTurnHandler>[0]['agentFor']) {
  const sent: string[] = [];
  const typing: string[] = [];
  const speakers: unknown[] = [];
  const { clock, advance } = manualClock();
  const inner = createAnswerEmitter({
    sendText: async (_j, t) => void sent.push(t),
    speakerHistory: new InMemorySpeakerHistoryStore(),
  });
  const handler = createTurnHandler({
    agentFor: agent,
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
    const { handler, sent, typing } = setup(() => fakeAgent([{ text: 'Fertig.', speaker: mira }]));
    await handler.handle(turn);
    assert.deepEqual(typing, [JID]);
    assert.deepEqual(sent, ['Fertig.']);
  });

  it('slow work: typing renewed, exactly one acknowledgement as system text, then the answer', async () => {
    const d = deferredAgent();
    const { handler, sent, typing, speakers, advance } = setup(() => d.agent);
    const running = handler.handle(turn);
    await advance(7_999);
    assert.deepEqual(sent, []);
    await advance(2);
    await advance(120_000);
    assert.deepEqual(sent, [paceAckText(undefined)], 'one acknowledgement, no progress chatter');
    assert.ok(typing.length > 3, `typing renewed (${String(typing.length)}x)`);
    d.release({ text: 'Der Bericht liegt vor.', speaker: mira });
    await running;
    assert.deepEqual(sent, [paceAckText(undefined), 'Der Bericht liegt vor.']);
    assert.deepEqual(speakers, [{ kind: 'system' }, mira], 'the acknowledgement is attributed too');
  });

  it('typing stops once the turn is over', async () => {
    const d = deferredAgent();
    const { handler, typing, advance } = setup(() => d.agent);
    const running = handler.handle(turn);
    d.release({ text: 'ok', speaker: mira });
    await running;
    const before = typing.length;
    await advance(60_000);
    assert.equal(typing.length, before);
  });

  it('work that fails after the acknowledgement ends in a system error text, not silence', async () => {
    const d = deferredAgent();
    const { handler, sent, advance } = setup(() => d.agent);
    const running = handler.handle(turn);
    await advance(9_000);
    d.fail(new Error('agent failed'));
    await running;
    assert.deepEqual(sent, [paceAckText(undefined), TURN_FAILED_TEXT]);
  });
});
