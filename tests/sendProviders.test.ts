import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  InMemorySpeakerHistoryStore,
  renderCardAsText,
  type QuestionCard,
  type SemanticAnswer,
  type TargetedPoll,
} from '@omadia/channel-sdk';

import { createAnswerEmitter } from '../src/emit.js';
import { OpenCardRegistry } from '../src/openCards.js';
import { createWhatsAppSendProviders, jidForTarget, type SendPolicy } from '../src/sendProviders.js';

const ANNA = '4917111111111@s.whatsapp.net';
const GROUP = '120363000000000000@g.us';

const poll: TargetedPoll = {
  pollId: 'poll-1',
  question: 'Welcher Termin passt?',
  options: [
    { id: 'tue', label: 'Dienstag' },
    { id: 'wed', label: 'Mittwoch' },
  ],
  hint: 'Bis Freitag.',
};

function setup(over: { policy?: Partial<SendPolicy>; canReceiveCardAnswers?: boolean; failSend?: boolean } = {}) {
  const sent: Array<{ jid: string; text: string }> = [];
  const speakers: Array<SemanticAnswer['speaker']> = [];
  let counter = 0;
  const inner = createAnswerEmitter({
    sendText: async (jid, text) => {
      if (over.failSend) throw new Error('WhatsApp socket not connected');
      sent.push({ jid, text });
      counter += 1;
      return `WA${String(counter)}`;
    },
    speakerHistory: new InMemorySpeakerHistoryStore(),
  });
  const cards = new OpenCardRegistry();
  const providers = createWhatsAppSendProviders({
    emitter: {
      emit: (jid, answer) => {
        speakers.push(answer.speaker);
        return inner.emit(jid, answer);
      },
    },
    cards,
    policy: { ignoreGroups: false, allowlist: new Set(), ...over.policy },
    canReceiveCardAnswers: over.canReceiveCardAnswers ?? true,
  });
  return { ...providers, cards, sent, speakers };
}

describe('send providers: what WhatsApp declares and does', () => {
  it('declares polls and one-question cards, and NOT a named identity, mentions or an AI label', () => {
    const { targeted, conversation } = setup();
    for (const provider of [targeted, conversation]) {
      assert.equal(provider.channelType, 'whatsapp');
      assert.equal(provider.supports?.poll, true);
      assert.equal(provider.supports?.asChannelKey, undefined, 'one number cannot be another agent\'s own identity');
      assert.equal(provider.supports?.mentions, undefined);
      assert.equal(provider.supports?.aiLabel, undefined);
      assert.equal(provider.supports?.card?.maxQuestions, 1);
      assert.equal(provider.supports?.card?.update, false);
      assert.ok(!provider.supports?.card?.kinds.includes('assignment'));
    }
    assert.equal('updateCard' in conversation, false);
  });

  it('declares no polls or cards when the kernel cannot take typed answers', () => {
    const { targeted } = setup({ canReceiveCardAnswers: false });
    assert.deepEqual(targeted.supports, {});
  });

  it('a DM goes out as ONE system text through the single emitter and reports its ids', async () => {
    const { targeted, sent, speakers } = setup();
    const outcome = await targeted.sendToUser(
      { principalId: `user:whatsapp-phone:${ANNA}` },
      { text: 'Der Bericht liegt vor.', attachments: [{ kind: 'image', url: 'https://x.test/a.png', altText: 'Chart' } as never] },
    );
    assert.deepEqual(outcome, { outcome: 'delivered', messageId: 'WA1', conversationId: ANNA });
    assert.deepEqual(sent, [{ jid: ANNA, text: 'Der Bericht liegt vor.\n\nChart: https://x.test/a.png' }]);
    assert.deepEqual(speakers, [{ kind: 'system' }], 'the plugin cannot name an agent here, so it speaks as the system');
  });

  it('refuses to send as a named identity rather than substituting the number\'s own', async () => {
    const { targeted, conversation, sent } = setup();
    const dm = await targeted.sendToUser({ principalId: `user:whatsapp-phone:${ANNA}` }, { text: 'x' }, { asChannelKey: 'whatsapp:mira' });
    const group = await conversation.sendToConversation(GROUP, { text: 'x' }, { asChannelKey: 'whatsapp:mira' });
    for (const outcome of [dm, group]) {
      assert.equal(outcome.outcome, 'unreachable');
      assert.equal(outcome.outcome === 'unreachable' && outcome.code, 'not_permitted');
    }
    assert.equal(sent.length, 0);
  });

  it('names a principal it cannot reach: an e-mail principal is not a WhatsApp number', async () => {
    const { targeted, sent } = setup();
    const outcome = await targeted.sendToUser({ principalId: 'user:anna@example.com' }, { text: 'x' });
    assert.equal(outcome.outcome === 'unreachable' && outcome.code, 'user_not_found');
    assert.equal(sent.length, 0);
    assert.equal(jidForTarget({ principalId: 'user:anna@example.com', userRef: { kind: 'whatsapp-phone', id: ANNA } }), ANNA);
    assert.equal(jidForTarget({ principalId: `user:whatsapp-phone:${ANNA}` }), ANNA);
    assert.equal(jidForTarget({ principalId: 'user:telegram-chat:12' }), undefined);
  });

  it('honours the operator\'s allowlist for outbound messages; a LID never passes a set allowlist', async () => {
    const { targeted, conversation, sent } = setup({ policy: { allowlist: new Set(['4917111111111']) } });
    assert.equal((await targeted.sendToUser({ principalId: `user:whatsapp-phone:${ANNA}` }, { text: 'ok' })).outcome, 'delivered');
    const other = await targeted.sendToUser({ principalId: 'user:whatsapp-phone:4917999999999@s.whatsapp.net' }, { text: 'no' });
    assert.equal(other.outcome === 'unreachable' && other.code, 'not_permitted');
    const lid = await conversation.sendToConversation('55512345678@lid', { text: 'no' });
    assert.equal(lid.outcome === 'unreachable' && lid.code, 'not_permitted');
    assert.equal(sent.length, 1);
  });

  it('stays out of groups when the operator ignores groups', async () => {
    const { conversation, sent } = setup({ policy: { ignoreGroups: true } });
    const outcome = await conversation.sendToConversation(GROUP, { text: 'x' });
    assert.equal(outcome.outcome === 'unreachable' && outcome.code, 'not_permitted');
    assert.equal(sent.length, 0);
  });

  it('returns unreachability, never throws: a dead socket and a foreign id', async () => {
    const dead = setup({ failSend: true });
    const outcome = await dead.targeted.sendToUser({ principalId: `user:whatsapp-phone:${ANNA}` }, { text: 'x' });
    assert.equal(outcome.outcome === 'unreachable' && outcome.code, 'channel_error');
    const { conversation } = setup();
    const foreign = await conversation.sendToConversation('19:abc@thread.v2', { text: 'x' });
    assert.equal(foreign.outcome === 'unreachable' && foreign.code, 'no_binding');
  });
});

describe('polls and cards go out as numbered text (criterion 30)', () => {
  it('a poll is one message: the question, the numbered options, and the card id round-trips', async () => {
    const { conversation, sent, cards } = setup();
    const outcome = await conversation.sendToConversation(GROUP, { text: 'Kurze Abstimmung:', poll });
    assert.deepEqual(outcome, { outcome: 'delivered', messageId: 'WA1', cardMessageId: 'WA1', conversationId: GROUP });
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.text, /Kurze Abstimmung:/);
    assert.match(sent[0]!.text, /Welcher Termin passt\?/);
    assert.match(sent[0]!.text, /1\) Dienstag\n2\) Mittwoch/);
    const open = cards.find(GROUP);
    assert.equal(open?.card.cardId, 'poll-1');
    assert.equal(open?.messageId, 'WA1');
  });

  it('an invalid poll is refused before anything is posted', async () => {
    const { conversation, sent } = setup();
    for (const bad of [
      { ...poll, options: [poll.options[0]!] },
      { ...poll, question: '  ' },
      { ...poll, options: [poll.options[0]!, poll.options[0]!] },
      { ...poll, options: Array.from({ length: 7 }, (_, i) => ({ id: `o${String(i)}`, label: `O${String(i)}` })) },
    ]) {
      const outcome = await conversation.sendToConversation(GROUP, { text: 'x', poll: bad });
      assert.equal(outcome.outcome === 'unreachable' && outcome.code, 'channel_error');
    }
    assert.equal(sent.length, 0);
  });

  it('a one-question card is rendered with the SDK text renderer', async () => {
    const card: QuestionCard = {
      cardId: 'c1',
      title: 'Wie weiter?',
      questions: [{ id: 'q1', kind: 'multiple_choice', label: 'Welche Themen?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }],
    };
    const { targeted, sent } = setup();
    const outcome = await targeted.sendToUser({ principalId: `user:whatsapp-phone:${ANNA}` }, { text: '', card });
    assert.equal(outcome.outcome, 'delivered');
    assert.equal(sent[0]!.text, renderCardAsText(card));
  });

  it('refuses a card it cannot render as one typed reply: several questions, or an assignment', async () => {
    const { targeted, sent } = setup();
    const two: QuestionCard = {
      cardId: 'c2',
      title: 't',
      questions: [
        { id: 'q1', kind: 'number', label: 'a' },
        { id: 'q2', kind: 'number', label: 'b' },
      ],
    };
    const assignment: QuestionCard = {
      cardId: 'c3',
      title: 't',
      questions: [{ id: 'q1', kind: 'assignment', label: 'Wer?', candidates: 'conversation_members' }],
    };
    for (const card of [two, assignment]) {
      const outcome = await targeted.sendToUser({ principalId: `user:whatsapp-phone:${ANNA}` }, { text: '', card });
      assert.equal(outcome.outcome === 'unreachable' && outcome.code, 'channel_error');
    }
    assert.equal(sent.length, 0);
  });

  it('a poll and a card together are refused', async () => {
    const { conversation, sent } = setup();
    const card: QuestionCard = { cardId: 'c', title: 't', questions: [{ id: 'q', kind: 'date', label: 'Wann?' }] };
    const outcome = await conversation.sendToConversation(GROUP, { text: '', poll, card });
    assert.equal(outcome.outcome === 'unreachable' && outcome.code, 'channel_error');
    assert.equal(sent.length, 0);
  });

  it('without a kernel that takes typed answers, a poll is refused instead of posted unanswerable', async () => {
    const { conversation, sent } = setup({ canReceiveCardAnswers: false });
    const outcome = await conversation.sendToConversation(GROUP, { text: '', poll });
    assert.equal(outcome.outcome === 'unreachable' && outcome.code, 'channel_error');
    assert.equal(sent.length, 0);
  });
});
