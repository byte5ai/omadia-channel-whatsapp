import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  InMemorySpeakerHistoryStore,
  type QuestionCard,
  type SemanticAnswer,
  type TargetedPoll,
} from '@omadia/channel-sdk';

import { createAnswerEmitter } from '../src/emit.js';
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

function setup(over: { policy?: Partial<SendPolicy>; failSend?: boolean } = {}) {
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
  const providers = createWhatsAppSendProviders({
    emitter: {
      emit: (jid, answer) => {
        speakers.push(answer.speaker);
        return inner.emit(jid, answer);
      },
    },
    policy: { ignoreGroups: false, allowlist: new Set(), ...over.policy },
  });
  return { ...providers, sent, speakers };
}

describe('send providers: what WhatsApp declares and does', () => {
  it('declares nothing: no named identity (one number), no mentions, no AI label, no native polls or cards', () => {
    const { targeted, conversation } = setup();
    for (const provider of [targeted, conversation]) {
      assert.equal(provider.channelType, 'whatsapp');
      assert.deepEqual(provider.supports, {});
    }
    assert.equal('updateCard' in conversation, false);
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

describe('polls and cards are the kernel\'s to render (criterion 30 is tested kernel-side)', () => {
  it('a poll or card that reaches the provider anyway is refused, not posted as unanswerable text', async () => {
    const { conversation, targeted, sent } = setup();
    const card: QuestionCard = { cardId: 'c', title: 't', questions: [{ id: 'q', kind: 'date', label: 'Wann?' }] };
    for (const message of [{ text: 'x', poll }, { text: 'x', card }]) {
      const a = await conversation.sendToConversation(GROUP, message);
      const b = await targeted.sendToUser({ principalId: `user:whatsapp-phone:${ANNA}` }, message);
      for (const outcome of [a, b]) assert.equal(outcome.outcome === 'unreachable' && outcome.code, 'channel_error');
    }
    assert.equal(sent.length, 0);
  });

  it('the numbered text the kernel posts goes out as ONE message and its WhatsApp id is reported, so a reply can name it', async () => {
    const { conversation, sent } = setup();
    const text = 'Kurze Abstimmung:\n\nWelcher Termin passt?\n1) Dienstag\n2) Mittwoch';
    const outcome = await conversation.sendToConversation(GROUP, { text });
    assert.deepEqual(outcome, { outcome: 'delivered', messageId: 'WA1', conversationId: GROUP });
    assert.deepEqual(sent, [{ jid: GROUP, text }]);
  });
});
