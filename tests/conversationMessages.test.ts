import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ConversationMessageEvent, IncomingTurn } from '@omadia/channel-sdk';

import { createMessageEvents, whatsAppInstallationKey, type DeliveryMode } from '../src/conversationMessages.js';
import { buildIncomingTurn } from '../src/inbound.js';
import { OWN, textMessage } from './helpers.js';

const ANNA = '4917111111111@s.whatsapp.net';
const GROUP = '120363000000000000@g.us';
const KEY = `whatsapp:${OWN.jid}`;

function quotedTurn(jid: string, text: string, quotedId: string, participant?: string): IncomingTurn {
  const base = textMessage({ jid, text, id: 'IN1', ...(participant ? { participant } : {}) });
  const msg = {
    ...base,
    messageTimestamp: 1_790_000_000,
    message: { extendedTextMessage: { text, contextInfo: { quotedMessage: { conversation: 'poll' }, participant: OWN.jid, stanzaId: quotedId } } },
  } as typeof base;
  return buildIncomingTurn('wa', msg, text);
}

function setup(mode: DeliveryMode | undefined, opts: { key?: string | undefined; noEmit?: boolean } = {}) {
  const events: ConversationMessageEvent[] = [];
  const asked: Array<[string, string]> = [];
  const events$ = createMessageEvents({
    channelId: 'wa',
    emit: opts.noEmit ? undefined : (e) => void events.push(e),
    delivery: mode === undefined ? undefined : (c, k) => (asked.push([c, k]), mode),
    installationKey: () => ('key' in opts ? opts.key : KEY),
    log: () => {},
    now: () => new Date('2026-11-20T10:00:00.000Z'),
  });
  return { events$, events, asked };
}

describe('created events: what the kernel needs to read a typed reply (criterion 30, kernel-side)', () => {
  it('a reply to the question message names it (replyToMessageId = the WhatsApp id) and addresses the bot', () => {
    const { events$, events } = setup('addressed');
    const turn = quotedTurn(GROUP, '2', 'WA1', ANNA);
    events$.created(turn, 'reply_to_bot');
    assert.equal(events.length, 1);
    const e = events[0]!;
    assert.equal(e.kind, 'created');
    assert.equal(e.channelType, 'whatsapp');
    assert.equal(e.conversationId, GROUP);
    assert.equal(e.conversationType, 'group');
    assert.equal(e.receivedByChannelKey, KEY);
    assert.equal(e.messageId, 'IN1');
    assert.equal(e.replyToMessageId, 'WA1');
    assert.equal(e.quoted, true);
    assert.equal(e.addressedToBot, true);
    assert.equal(e.text, '2');
    assert.equal(e.author.id, ANNA, 'the platform-stated sender');
    assert.equal(e.occurredAt, new Date(1_790_000_000 * 1000).toISOString());
  });

  it('a direct chat message addresses the bot; an unquoted one has no replyToMessageId', () => {
    const { events$, events } = setup('addressed');
    events$.created(buildIncomingTurn('wa', textMessage({ jid: ANNA, text: '1', id: 'IN2' }), '1'), 'direct');
    assert.equal(events[0]!.addressedToBot, true);
    assert.equal('replyToMessageId' in events[0]!, false);
  });

  it('delivery modes: addressed hands over only what addresses the bot, all hands over everything, none nothing', () => {
    const turn = buildIncomingTurn('wa', textMessage({ jid: GROUP, participant: ANNA, text: 'Wer kommt?', id: 'IN3' }), 'Wer kommt?');
    for (const [mode, addressing, expected] of [
      ['addressed', undefined, 0],
      ['addressed', 'mention', 1],
      ['all', undefined, 1],
      ['none', 'mention', 0],
    ] as const) {
      const { events$, events, asked } = setup(mode);
      assert.equal(events$.created(turn, addressing), mode);
      assert.equal(events.length, expected, `${mode}/${String(addressing)}`);
      assert.deepEqual(asked, [[GROUP, KEY]], 'asked per conversation and identity');
    }
    const { events$, events } = setup('all');
    events$.created(turn, undefined);
    assert.equal(events[0]!.addressedToBot, false, 'an unaddressed message is not addressed to the bot');
  });

  it('without a delivery answer only addressed messages are emitted (the kernel drops what nobody subscribed)', () => {
    const { events$, events } = setup(undefined);
    const turn = buildIncomingTurn('wa', textMessage({ jid: GROUP, participant: ANNA, text: 'x', id: 'IN4' }), 'x');
    events$.created(turn, undefined);
    events$.created(turn, 'mention');
    assert.equal(events.length, 1);
  });

  it('emits nothing before the account is linked or on a kernel without the seam, and the turn is not left to the engine', () => {
    const turn = buildIncomingTurn('wa', textMessage({ jid: ANNA, text: 'x', id: 'IN5' }), 'x');
    const unlinked = setup('all', { key: undefined });
    assert.equal(unlinked.events$.created(turn, 'direct'), 'none');
    assert.equal(unlinked.events.length, 0);
    assert.equal(setup('all', { noEmit: true }).events$.created(turn, 'direct'), 'none');
  });

  it('a failing emit never breaks the message', () => {
    const logs: string[] = [];
    const events$ = createMessageEvents({
      channelId: 'wa',
      emit: () => {
        throw new Error('hub down');
      },
      delivery: () => 'all',
      installationKey: () => KEY,
      log: (_l, m) => void logs.push(m),
    });
    const turn = buildIncomingTurn('wa', textMessage({ jid: ANNA, text: 'x', id: 'IN6' }), 'x');
    assert.equal(events$.created(turn, 'direct'), 'none', 'the channel\'s turn still runs');
    assert.equal(logs.length, 1);
  });

  it('the installation key is the linked account, lowercase, empty until linked', () => {
    assert.equal(whatsAppInstallationKey(OWN), `whatsapp:${OWN.jid}`);
    assert.equal(whatsAppInstallationKey({ jid: '', lid: '' }), undefined);
  });
});
