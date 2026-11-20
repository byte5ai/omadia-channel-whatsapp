import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  InMemorySpeakerHistoryStore,
  formatPrincipal,
  type ChannelBindingResolver,
  type ChannelRouteContext,
  type IncomingTurn,
  type SemanticAnswer,
  type SystemNotice,
} from '@omadia/channel-sdk';
import type { WAMessage } from '@whiskeysockets/baileys';

import { createAnswerEmitter } from '../src/emit.js';
import { groupAddressing, stripOwnMention } from '../src/groupAddressing.js';
import { buildIncomingTurn, buildTurnOrigin, principalRefOf, routePrincipalOf } from '../src/inbound.js';
import { createTurnRouter, routeLocaleOf } from '../src/routing.js';
import { NO_AGENT_TEXT, TURN_FAILED_TEXT, createTurnHandler } from '../src/turnHandler.js';
import { OWN, fakeAgent, mira, textMessage } from './helpers.js';

const ANNA_PN = '4917111111111@s.whatsapp.net';
const ANNA_LID = '55512345678@lid';
const GROUP = '120363000000000000@g.us';

const notice: SystemNotice = {
  code: 'agent_not_available',
  agent: { slug: 'mira', displayName: 'Mira', agentId: 'a-mira' },
  text: 'Mira ist für dich hier nicht verfügbar.',
  locale: 'de',
};

function withKey(msg: WAMessage, extra: Record<string, string>): WAMessage {
  return { ...msg, key: { ...msg.key, ...extra } } as WAMessage;
}

function recording() {
  const sent: string[] = [];
  const speakers: Array<SemanticAnswer['speaker']> = [];
  const inner = createAnswerEmitter({
    sendText: async (_j, t) => void sent.push(t),
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

function resolverReturning(result: ReturnType<ChannelBindingResolver['resolve']>) {
  const calls: Array<{ key: string; context: ChannelRouteContext | undefined }> = [];
  const resolve = (key: string, context?: ChannelRouteContext) => {
    calls.push({ key, context });
    return result;
  };
  return { resolve, calls };
}

function direct(text: string): IncomingTurn {
  return buildIncomingTurn('wa', textMessage({ jid: ANNA_PN, text }), text);
}

describe('principal: one form for every channel (spec 5.3)', () => {
  it('a direct chat is user:whatsapp-phone:<jid>, built by the SDK helper', () => {
    const turn = direct('Hallo');
    const origin = buildTurnOrigin(turn, 'M1');
    assert.equal(routePrincipalOf(turn, origin), `user:whatsapp-phone:${ANNA_PN}`);
    assert.equal(origin.principal && formatPrincipal(origin.principal), `user:whatsapp-phone:${ANNA_PN}`);
    assert.ok(!routePrincipalOf(turn, origin).startsWith('user:whatsapp:'), 'the old hand-made form is gone');
  });

  it('LID group: the principal is the phone number when WhatsApp reveals it, so DM and group are one person', () => {
    const msg = withKey(textMessage({ jid: GROUP, participant: ANNA_LID, text: 'hi' }), { participantPn: ANNA_PN });
    const turn = buildIncomingTurn('wa', msg, 'hi');
    assert.equal(turn.userRef.id, ANNA_LID, 'userRef stays the id WhatsApp addresses the sender by in this chat');
    assert.deepEqual(principalRefOf(turn), { kind: 'whatsapp-phone', id: ANNA_PN });
    const dm = direct('hi');
    assert.equal(
      routePrincipalOf(turn, buildTurnOrigin(turn, undefined)),
      routePrincipalOf(dm, buildTurnOrigin(dm, undefined)),
    );
  });

  it('LID direct chat with senderPn resolves to the number as well', () => {
    const msg = withKey(textMessage({ jid: ANNA_LID, text: 'hi' }), { senderPn: ANNA_PN });
    const turn = buildIncomingTurn('wa', msg, 'hi');
    assert.equal(routePrincipalOf(turn, buildTurnOrigin(turn, undefined)), `user:whatsapp-phone:${ANNA_PN}`);
  });

  it('LID only: the LID JID is the principal id (no number is guessed)', () => {
    const msg = textMessage({ jid: GROUP, participant: ANNA_LID, text: 'hi' });
    const turn = buildIncomingTurn('wa', msg, 'hi');
    assert.equal(routePrincipalOf(turn, buildTurnOrigin(turn, undefined)), `user:whatsapp-phone:${ANNA_LID}`);
  });

  it('the router hands the resolver the conversation as key and the principal as context', () => {
    const { resolve, calls } = resolverReturning({ decision: 'bound', chatAgent: fakeAgent([]), speaker: mira });
    const route = createTurnRouter({ resolve, singleAgent: () => undefined });
    const turn = direct('Hallo');
    const principal = routePrincipalOf(turn, buildTurnOrigin(turn, undefined));
    const decided = route(turn, principal);
    assert.equal(decided.decision, 'bound');
    assert.deepEqual(decided.speaker, mira);
    assert.deepEqual(calls, [{ key: ANNA_PN, context: { principal } }], 'chat JID is the key; no locale WhatsApp did not state');
  });
});

describe('routing contract: bound / reject, no fallback agent', () => {
  it('without a resolver the single orchestrator answers (minimal deployment)', () => {
    const agent = fakeAgent([]);
    const route = createTurnRouter({ resolve: () => undefined, singleAgent: () => agent });
    assert.equal(route(direct('x'), 'user:whatsapp-phone:x').chatAgent, agent);
  });

  it('with a resolver the singleton is never a fallback: a reject stays a reject', () => {
    const { resolve } = resolverReturning({ decision: 'reject', notice });
    const route = createTurnRouter({ resolve, singleAgent: () => fakeAgent([]) });
    const decided = route(direct('x'), 'user:whatsapp-phone:x');
    assert.equal(decided.decision, 'reject');
    assert.equal(decided.chatAgent, undefined);
  });

  it('reject with the resolver\'s agent: the text still reaches it (it handles /agent), the answer is system', async () => {
    const agent = fakeAgent([{ text: notice.text, speaker: { kind: 'system' }, systemNotice: notice }]);
    const { emitter, sent, speakers } = recording();
    const handler = createTurnHandler({
      route: () => ({ decision: 'reject', chatAgent: agent, notice }),
      emitter,
      log: () => {},
    });
    await handler.handle(direct('/agent Mira'));
    assert.equal(agent.inputs[0]!['userMessage'], '/agent Mira');
    assert.deepEqual(sent, [notice.text]);
    assert.deepEqual(speakers, [{ kind: 'system' }]);
  });

  it('a rejected turn never produces an agent answer: the notice is posted as system instead', async () => {
    const agent = fakeAgent([{ text: 'Ich helfe dir gern!', speaker: mira }]);
    const { emitter, sent, speakers } = recording();
    const logs: string[] = [];
    const handler = createTurnHandler({
      route: () => ({ decision: 'reject', chatAgent: agent, notice }),
      emitter,
      log: (_l, m) => void logs.push(m),
    });
    await handler.handle(direct('Hallo'));
    assert.deepEqual(sent, [notice.text]);
    assert.deepEqual(speakers, [{ kind: 'system' }]);
    assert.ok(logs.some((m) => m.includes('non-system')));
  });

  it('reject without any agent (older platform): the notice is posted as system; without a notice, a plain system text', async () => {
    const { emitter, sent, speakers } = recording();
    const withNotice = createTurnHandler({ route: () => ({ decision: 'reject', notice }), emitter, log: () => {} });
    await withNotice.handle(direct('Hallo'));
    const bare = createTurnHandler({ route: () => ({ decision: 'reject' }), emitter, log: () => {} });
    await bare.handle(direct('Hallo'));
    assert.deepEqual(sent, [notice.text, NO_AGENT_TEXT]);
    assert.deepEqual(speakers, [{ kind: 'system' }, { kind: 'system' }]);
  });

  it('a resolver that throws fails the turn loudly as system, not into a default agent', async () => {
    const resolve = (): never => {
      throw new Error('registry down');
    };
    const { emitter, sent, speakers } = recording();
    const fallback = fakeAgent([{ text: 'must not answer', speaker: mira }]);
    const handler = createTurnHandler({
      route: createTurnRouter({ resolve, singleAgent: () => fallback }),
      emitter,
      log: () => {},
    });
    await handler.handle(direct('Hallo'));
    assert.deepEqual(sent, [TURN_FAILED_TEXT]);
    assert.deepEqual(speakers, [{ kind: 'system' }]);
    assert.equal(fallback.inputs.length, 0);
  });

  it('bound without an agent is a failure, not silence', async () => {
    const { emitter, sent } = recording();
    const handler = createTurnHandler({ route: () => ({ decision: 'bound' }), emitter, log: () => {} });
    await handler.handle(direct('Hallo'));
    assert.deepEqual(sent, [TURN_FAILED_TEXT]);
  });
});

describe('selection key and locale (S1: tightest conversation key + principal)', () => {
  it('the key is the group JID for a group and the sender\'s chat for a direct chat', () => {
    const { resolve, calls } = resolverReturning({ decision: 'reject', notice });
    const route = createTurnRouter({ resolve, singleAgent: () => undefined });
    const group = buildIncomingTurn('wa', textMessage({ jid: GROUP, participant: ANNA_PN, text: 'x' }), 'x');
    route(group, 'user:whatsapp-phone:a');
    route(direct('x'), 'user:whatsapp-phone:a');
    assert.deepEqual(calls.map((c) => c.key), [GROUP, ANNA_PN]);
  });

  it('a direct chat by number and by LID is the same selection key (the number once it is known)', () => {
    const { resolve, calls } = resolverReturning({ decision: 'reject', notice });
    const route = createTurnRouter({ resolve, singleAgent: () => undefined });
    const byNumber = direct('x');
    const byLid = buildIncomingTurn('wa', withKey(textMessage({ jid: ANNA_LID, text: 'x' }), { senderPn: ANNA_PN }), 'x');
    const lidOnly = buildIncomingTurn('wa', textMessage({ jid: ANNA_LID, text: 'x' }), 'x');
    for (const turn of [byNumber, byLid, lidOnly]) route(turn, 'p');
    assert.deepEqual(calls.map((c) => c.key), [ANNA_PN, ANNA_PN, ANNA_LID]);
    assert.equal(byLid.conversationId, ANNA_LID, 'the send target stays what WhatsApp addresses');
  });

  it('a group keeps the group JID even when the sender\'s number is known', () => {
    const { resolve, calls } = resolverReturning({ decision: 'reject', notice });
    const route = createTurnRouter({ resolve, singleAgent: () => undefined });
    route(buildIncomingTurn('wa', withKey(textMessage({ jid: GROUP, participant: ANNA_LID, text: 'x' }), { participantPn: ANNA_PN }), 'x'), 'p');
    assert.deepEqual(calls.map((c) => c.key), [GROUP]);
  });

  it('WhatsApp states no language, so the locale is left out; a stated one is normalised and passed on', () => {
    assert.equal(routeLocaleOf(direct('x')), undefined);
    const { resolve, calls } = resolverReturning({ decision: 'reject', notice });
    const route = createTurnRouter({ resolve, singleAgent: () => undefined });
    route(direct('x'), 'p');
    route({ ...direct('x'), metadata: { locale: 'en-GB' } }, 'p');
    route({ ...direct('x'), metadata: { locale: 'fr' } }, 'p');
    assert.deepEqual(calls.map((c) => c.context), [{ principal: 'p' }, { principal: 'p', locale: 'en' }, { principal: 'p' }]);
  });

  it('with a resolver the chatAgent@1 singleton is never read', () => {
    const { resolve } = resolverReturning({ decision: 'reject', notice });
    const route = createTurnRouter({ resolve, singleAgent: () => assert.fail('singleton read despite resolver') });
    assert.equal(route(direct('x'), 'p').decision, 'reject');
  });
});

describe('agent commands pass through as plain text (spec 5.3, criterion 30)', () => {
  const cases: Array<{ command: string; code: SystemNotice['code']; text: string }> = [
    { command: '/agent Mira', code: 'agent_selected', text: 'Du sprichst jetzt mit Mira.' },
    { command: '/agent', code: 'agent_selection_cleared', text: 'Deine Auswahl ist aufgehoben.' },
    { command: '/agents', code: 'agent_directory', text: 'Hier verfügbar: Mira, Jonas.' },
  ];

  for (const { command, code, text } of cases) {
    it(`${command} reaches the resolver's agent verbatim; its system notice comes back`, async () => {
      const systemNotice: SystemNotice = { code, text, locale: 'de' };
      const agent = fakeAgent([{ text, speaker: { kind: 'system' }, systemNotice }]);
      const { emitter, sent, speakers } = recording();
      const handler = createTurnHandler({ route: () => ({ decision: 'bound', chatAgent: agent, speaker: mira }), emitter, log: () => {} });
      await handler.handle(direct(command));
      assert.equal(agent.inputs[0]!['userMessage'], command, 'no channel-side parsing or rewriting');
      assert.deepEqual(sent, [text]);
      assert.deepEqual(speakers, [{ kind: 'system' }], 'the confirmation is the system\'s, not the agent\'s');
    });
  }

  it('in a group the commands count as addressed, and "@bot /agents" arrives as "/agents"', () => {
    for (const command of ['/agent Mira', '/agent', '/agents']) {
      const msg = textMessage({ jid: GROUP, participant: ANNA_PN, text: command });
      assert.equal(groupAddressing(msg, command, OWN), 'agent_command');
    }
    const mention = '@4915100000000 /agents';
    const msg = textMessage({ jid: GROUP, participant: ANNA_PN, text: mention, mentioned: [OWN.jid] });
    assert.equal(groupAddressing(msg, mention, OWN), 'mention');
    assert.equal(stripOwnMention(mention, OWN), '/agents');
  });
});
