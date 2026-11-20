import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ConversationMessageEvent, IncomingTurn } from '@omadia/channel-sdk';

import { createMessageEvents, handleAddressed, whatsAppInstallationKey, type DeliveryMode } from '../src/conversationMessages.js';
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

type Report = (e: ConversationMessageEvent) => Promise<{ answeredCard: boolean }>;

function setup(mode: DeliveryMode | undefined, opts: { key?: string | undefined; noEmit?: boolean; report?: Report; timeoutMs?: number } = {}) {
  const events: ConversationMessageEvent[] = [];
  const asked: Array<[string, string]> = [];
  const events$ = createMessageEvents({
    channelId: 'wa',
    emit: opts.noEmit ? undefined : (e) => void events.push(e),
    report: opts.report,
    ...(opts.timeoutMs !== undefined ? { reportTimeoutMs: opts.timeoutMs } : {}),
    delivery: mode === undefined ? undefined : (c, k) => (asked.push([c, k]), mode),
    installationKey: () => ('key' in opts ? opts.key : KEY),
    log: () => {},
    now: () => new Date('2026-11-20T10:00:00.000Z'),
  });
  return { events$, events, asked };
}

describe('created events: what the kernel needs to read a typed reply (criterion 30, kernel-side)', () => {
  it('a reply to the question message names it (replyToMessageId = the WhatsApp id) and addresses the bot', async () => {
    const { events$, events } = setup('addressed');
    const turn = quotedTurn(GROUP, '2', 'WA1', ANNA);
    await events$.created(turn, 'reply_to_bot');
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

  it('a direct chat message addresses the bot; an unquoted one has no replyToMessageId', async () => {
    const { events$, events } = setup('addressed');
    await events$.created(buildIncomingTurn('wa', textMessage({ jid: ANNA, text: '1', id: 'IN2' }), '1'), 'direct');
    assert.equal(events[0]!.addressedToBot, true);
    assert.equal('replyToMessageId' in events[0]!, false);
  });

  it('delivery modes: addressed hands over only what addresses the bot, all hands over everything, none nothing', async () => {
    const turn = buildIncomingTurn('wa', textMessage({ jid: GROUP, participant: ANNA, text: 'Wer kommt?', id: 'IN3' }), 'Wer kommt?');
    for (const [mode, addressing, expected] of [
      ['addressed', undefined, 0],
      ['addressed', 'mention', 1],
      ['all', undefined, 1],
      ['none', 'mention', 0],
    ] as const) {
      const { events$, events, asked } = setup(mode);
      assert.equal((await events$.created(turn, addressing)).mode, mode);
      assert.equal(events.length, expected, `${mode}/${String(addressing)}`);
      assert.deepEqual(asked, [[GROUP, KEY]], 'asked per conversation and identity');
    }
    const { events$, events } = setup('all');
    await events$.created(turn, undefined);
    assert.equal(events[0]!.addressedToBot, false, 'an unaddressed message is not addressed to the bot');
  });

  it('without a delivery answer only addressed messages are emitted (the kernel drops what nobody subscribed)', async () => {
    const { events$, events } = setup(undefined);
    const turn = buildIncomingTurn('wa', textMessage({ jid: GROUP, participant: ANNA, text: 'x', id: 'IN4' }), 'x');
    await events$.created(turn, undefined);
    await events$.created(turn, 'mention');
    assert.equal(events.length, 1);
  });

  it('emits nothing before the account is linked or on a kernel without the seam, and the turn is not left to the engine', async () => {
    const turn = buildIncomingTurn('wa', textMessage({ jid: ANNA, text: 'x', id: 'IN5' }), 'x');
    const unlinked = setup('all', { key: undefined });
    assert.equal((await unlinked.events$.created(turn, 'direct')).mode, 'none');
    assert.equal(unlinked.events.length, 0);
    assert.equal((await setup('all', { noEmit: true }).events$.created(turn, 'direct')).mode, 'none');
  });

  it('a failing emit never breaks the message', async () => {
    const logs: string[] = [];
    const events$ = createMessageEvents({
      channelId: 'wa',
      emit: () => {
        throw new Error('hub down');
      },
      report: undefined,
      delivery: () => 'all',
      installationKey: () => KEY,
      log: (_l, m) => void logs.push(m),
    });
    const turn = buildIncomingTurn('wa', textMessage({ jid: ANNA, text: 'x', id: 'IN6' }), 'x');
    assert.equal((await events$.created(turn, 'direct')).mode, 'none', 'the channel\'s turn still runs');
    assert.equal(logs.length, 1);
  });

  it('the installation key is the linked account, lowercase, empty until linked', () => {
    assert.equal(whatsAppInstallationKey(OWN), `whatsapp:${OWN.jid}`);
    assert.equal(whatsAppInstallationKey({ jid: '', lid: '' }), undefined);
  });
});

describe('a typed answer starts no turn (reportConversationMessage)', () => {
  const dm = () => buildIncomingTurn('wa', textMessage({ jid: ANNA, text: '2', id: 'IN7' }), '2');

  async function run(opts: Parameters<typeof setup>[1], mode: DeliveryMode = 'addressed') {
    const { events$, events } = setup(mode, opts);
    let turns = 0;
    const started = await handleAddressed(events$, dm(), 'direct', async () => void (turns += 1));
    return { started, turns, events };
  }

  it('a message the kernel consumed as an answer starts NO turn', async () => {
    const reported: ConversationMessageEvent[] = [];
    const r = await run({ report: async (e) => (reported.push(e), { answeredCard: true }) });
    assert.deepEqual([r.started, r.turns], [false, 0]);
    assert.equal(reported.length, 1, 'reported, not emitted twice');
    assert.equal(r.events.length, 0);
    assert.equal(reported[0]!.addressedToBot, true);
  });

  it('a message the kernel did not consume starts the turn as usual', async () => {
    const r = await run({ report: async () => ({ answeredCard: false }) });
    assert.deepEqual([r.started, r.turns], [true, 1]);
  });

  it('a kernel that is too slow does not delay the turn: unknown counts as not answered', async () => {
    const logs: string[] = [];
    const slow: Report = () => new Promise(() => undefined);
    const events$ = createMessageEvents({
      channelId: 'wa', emit: () => undefined, report: slow, reportTimeoutMs: 20, delivery: () => 'addressed',
      installationKey: () => KEY, log: (_l, m) => void logs.push(m),
    });
    let turns = 0;
    const began = Date.now();
    await handleAddressed(events$, dm(), 'direct', async () => void (turns += 1));
    assert.equal(turns, 1);
    assert.ok(Date.now() - began < 1_000);
    assert.equal(logs.length, 1);
  });

  it('a report that fails is logged, never thrown, and the turn starts', async () => {
    const logs: string[] = [];
    const events$ = createMessageEvents({
      channelId: 'wa', emit: () => undefined, report: async () => { throw new Error('hub down'); },
      delivery: () => 'addressed', installationKey: () => KEY, log: (_l, m) => void logs.push(m),
    });
    let turns = 0;
    await handleAddressed(events$, dm(), 'direct', async () => void (turns += 1));
    assert.equal(turns, 1);
    assert.equal(logs.length, 1);
  });

  it('on a kernel without reportConversationMessage: emit and the turn, as before', async () => {
    const r = await run({ report: undefined });
    assert.deepEqual([r.started, r.turns, r.events.length], [true, 1, 1]);
  });

  it('delivery mode all stays as it was: the engine drives, no turn, plain emit', async () => {
    const r = await run({ report: async () => assert.fail('all does not ask') }, 'all');
    assert.deepEqual([r.started, r.turns, r.events.length], [false, 0, 1]);
  });

  it('delivery mode none or an unlinked account: the turn runs and nothing is reported', async () => {
    assert.equal((await run({ report: async () => assert.fail('none does not report') }, 'none')).turns, 1);
    assert.equal((await run({ key: undefined, report: async () => assert.fail('unlinked') })).turns, 1);
  });
});
