import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  InMemorySpeakerHistoryStore,
  type ConversationMessageEvent,
  type IncomingTurn,
  type QuestionCard,
  type TargetedPoll,
} from '@omadia/channel-sdk';

import {
  CARD_ANSWER_NOT_UNDERSTOOD_TEXT,
  CARD_ANSWER_RECORDED_TEXT,
  createCardReplyHandler,
  whatsAppInstallationKey,
} from '../src/cardReplies.js';
import { createAnswerEmitter } from '../src/emit.js';
import { buildIncomingTurn } from '../src/inbound.js';
import { OpenCardRegistry } from '../src/openCards.js';
import { createWhatsAppSendProviders } from '../src/sendProviders.js';
import { OWN, textMessage } from './helpers.js';

const ANNA = '4917111111111@s.whatsapp.net';
const BOB = '4917222222222@s.whatsapp.net';
const GROUP = '120363000000000000@g.us';

const poll: TargetedPoll = {
  pollId: 'poll-1',
  question: 'Welcher Termin passt?',
  options: [
    { id: 'tue', label: 'Dienstag' },
    { id: 'wed', label: 'Mittwoch' },
  ],
};

function world() {
  const sent: Array<{ jid: string; text: string }> = [];
  const events: ConversationMessageEvent[] = [];
  let counter = 0;
  const emitter = createAnswerEmitter({
    sendText: async (jid, text) => {
      sent.push({ jid, text });
      counter += 1;
      return `WA${String(counter)}`;
    },
    speakerHistory: new InMemorySpeakerHistoryStore(),
  });
  const registry = new OpenCardRegistry();
  const providers = createWhatsAppSendProviders({
    emitter,
    cards: registry,
    policy: { ignoreGroups: false, allowlist: new Set() },
    canReceiveCardAnswers: true,
  });
  const replies = createCardReplyHandler({
    channelId: 'wa',
    registry,
    emitter,
    emitMessage: (event) => void events.push(event),
    installationKey: () => whatsAppInstallationKey(OWN),
    log: () => {},
    now: () => new Date('2026-11-20T10:00:00.000Z'),
  });
  return { ...providers, registry, replies, sent, events };
}

function typed(jid: string, text: string, opts: { participant?: string; quoted?: string } = {}): IncomingTurn {
  const base = textMessage({
    jid,
    text,
    ...(opts.participant ? { participant: opts.participant } : {}),
    ...(opts.quoted ? { quotedParticipant: OWN.jid } : {}),
    id: 'IN1',
  });
  const msg = opts.quoted
    ? ({
        ...base,
        message: {
          extendedTextMessage: {
            text,
            contextInfo: { quotedMessage: { conversation: 'poll' }, participant: OWN.jid, stanzaId: opts.quoted },
          },
        },
      } as typeof base)
    : base;
  return buildIncomingTurn('wa', msg, text);
}

describe('criterion 30: answering a poll through plain text', () => {
  it('a poll in a group: the reply "2" becomes the same typed card_answer a card click would be', async () => {
    const w = world();
    await w.conversation.sendToConversation(GROUP, { text: '', poll });
    const consumed = await w.replies.tryHandle(typed(GROUP, '2', { participant: ANNA, quoted: 'WA1' }));
    assert.equal(consumed, true, 'the answer is not also sent to an agent');
    assert.equal(w.events.length, 1);
    const event = w.events[0]!;
    assert.equal(event.kind, 'card_answer');
    assert.equal(event.channelType, 'whatsapp');
    assert.equal(event.conversationId, GROUP);
    assert.equal(event.conversationType, 'group');
    assert.equal(event.messageId, 'WA1', 'the card message, as the kernel expects for a card_answer');
    assert.equal(event.receivedByChannelKey, `whatsapp:${OWN.jid}`);
    assert.equal(event.author.id, ANNA, 'the platform-stated sender, never text');
    assert.deepEqual(event.cardAnswer, { cardId: 'poll-1', value: { optionId: 'wed' }, answererVerified: true });
    assert.equal(w.sent.at(-1)?.text, CARD_ANSWER_RECORDED_TEXT);
  });

  it('in a group several people answer the same poll; the option may also be named', async () => {
    const w = world();
    await w.conversation.sendToConversation(GROUP, { text: '', poll });
    await w.replies.tryHandle(typed(GROUP, '1', { participant: ANNA, quoted: 'WA1' }));
    await w.replies.tryHandle(typed(GROUP, 'mittwoch', { participant: BOB, quoted: 'WA1' }));
    assert.deepEqual(
      w.events.map((e) => [e.author.id, (e.cardAnswer?.value as { optionId: string }).optionId]),
      [[ANNA, 'tue'], [BOB, 'wed']],
    );
  });

  it('a poll DM: a bare number answers it, once', async () => {
    const w = world();
    await w.targeted.sendToUser({ principalId: `user:whatsapp-phone:${ANNA}` }, { text: '', poll });
    assert.equal(await w.replies.tryHandle(typed(ANNA, '1')), true);
    assert.equal(w.events.length, 1);
    // a later "1" is an ordinary message again
    assert.equal(await w.replies.tryHandle(typed(ANNA, '1')), false);
    assert.equal(w.events.length, 1);
  });

  it('an ordinary message while a poll is open still goes to the agent', async () => {
    const w = world();
    await w.targeted.sendToUser({ principalId: `user:whatsapp-phone:${ANNA}` }, { text: '', poll });
    assert.equal(await w.replies.tryHandle(typed(ANNA, 'Wie ist das Wetter?')), false);
    assert.equal(w.events.length, 0);
  });

  it('a reply to the poll that is no answer is told, in words, and asked again', async () => {
    const w = world();
    await w.conversation.sendToConversation(GROUP, { text: '', poll });
    assert.equal(await w.replies.tryHandle(typed(GROUP, 'vielleicht', { participant: ANNA, quoted: 'WA1' })), true);
    assert.equal(w.events.length, 0);
    assert.equal(w.sent.at(-1)?.text, CARD_ANSWER_NOT_UNDERSTOOD_TEXT);
  });

  it('a question card with several kinds: multiple choice, ranking, consent, number, date, text', async () => {
    const w = world();
    const options = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }];
    const cases: Array<{ question: QuestionCard['questions'][number]; reply: string; expected: unknown }> = [
      { question: { id: 'q', kind: 'multiple_choice', label: 'm', options }, reply: '1,3', expected: { kind: 'multiple_choice', optionIds: ['a', 'c'] } },
      { question: { id: 'q', kind: 'ranking', label: 'r', options }, reply: '2,1,3', expected: { kind: 'ranking', ranking: ['b', 'a', 'c'] } },
      { question: { id: 'q', kind: 'consent', label: 'k' }, reply: 'ja', expected: { kind: 'consent', decision: 'agree' } },
      { question: { id: 'q', kind: 'number', label: 'n' }, reply: '3,5', expected: { kind: 'number', value: 3.5 } },
      { question: { id: 'q', kind: 'date', label: 'd' }, reply: '2026-12-01', expected: { kind: 'date', value: '2026-12-01' } },
    ];
    for (const [i, c] of cases.entries()) {
      const card: QuestionCard = { cardId: `card-${String(i)}`, proposalId: 'p1', proposalVersion: 2, title: 't', questions: [c.question] };
      await w.targeted.sendToUser({ principalId: `user:whatsapp-phone:${ANNA}` }, { text: '', card });
      assert.equal(await w.replies.tryHandle(typed(ANNA, c.reply)), true, c.reply);
      const answer = w.events.at(-1)!.cardAnswer!;
      assert.equal(answer.cardId, `card-${String(i)}`);
      assert.equal(answer.proposalId, 'p1');
      assert.equal(answer.proposalVersion, 2);
      assert.deepEqual(answer.answers, [{ questionId: 'q', ...(c.expected as object) }]);
    }
  });

  it('a free-text question takes only a message that replies to it', async () => {
    const w = world();
    const card: QuestionCard = { cardId: 'free', title: 'Anmerkung?', questions: [{ id: 'q', kind: 'text', label: 'Was noch?' }] };
    await w.conversation.sendToConversation(GROUP, { text: '', card });
    assert.equal(await w.replies.tryHandle(typed(GROUP, 'Schönen Tag!', { participant: ANNA })), false);
    assert.equal(w.events.length, 0);
    assert.equal(await w.replies.tryHandle(typed(GROUP, 'Bitte Budget klären', { participant: ANNA, quoted: 'WA1' })), true);
    assert.deepEqual(w.events[0]!.cardAnswer!.answers, [{ questionId: 'q', kind: 'text', text: 'Bitte Budget klären' }]);
  });

  it('with several open questions the reply picks the one it quotes', async () => {
    const w = world();
    await w.conversation.sendToConversation(GROUP, { text: '', poll });
    await w.conversation.sendToConversation(GROUP, { text: '', poll: { ...poll, pollId: 'poll-2' } });
    await w.replies.tryHandle(typed(GROUP, '1', { participant: ANNA, quoted: 'WA1' }));
    assert.equal(w.events[0]!.cardAnswer!.cardId, 'poll-1');
  });

  it('nothing is taken when no question is open, or before the account is linked', async () => {
    const w = world();
    assert.equal(await w.replies.tryHandle(typed(ANNA, '1')), false);
    await w.targeted.sendToUser({ principalId: `user:whatsapp-phone:${ANNA}` }, { text: '', poll });
    const unlinked = createCardReplyHandler({
      channelId: 'wa',
      registry: w.registry,
      emitter: createAnswerEmitter({ sendText: async () => undefined, speakerHistory: new InMemorySpeakerHistoryStore() }),
      emitMessage: () => assert.fail('must not emit'),
      installationKey: () => undefined,
      log: () => {},
    });
    assert.equal(await unlinked.tryHandle(typed(ANNA, '1')), false);
  });

  it('a question that closed stops taking answers', async () => {
    const card: QuestionCard = {
      cardId: 'late',
      title: 't',
      closesAt: '2026-11-20T09:00:00.000Z',
      questions: [{ id: 'q', kind: 'number', label: 'n' }],
    };
    const clockNow = Date.parse('2026-11-20T10:00:00.000Z');
    const closed = new OpenCardRegistry(() => clockNow);
    closed.open({ kind: 'card', conversationId: ANNA, card });
    const handler = createCardReplyHandler({
      channelId: 'wa',
      registry: closed,
      emitter: createAnswerEmitter({ sendText: async () => undefined, speakerHistory: new InMemorySpeakerHistoryStore() }),
      emitMessage: () => assert.fail('must not emit'),
      installationKey: () => 'whatsapp:x',
      log: () => {},
    });
    assert.equal(await handler.tryHandle(typed(ANNA, '5')), false);
    assert.equal(closed.find(ANNA), undefined);
  });
});
