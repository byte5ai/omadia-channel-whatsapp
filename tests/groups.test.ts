import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  groupAddressing,
  isAgentCommand,
  stripOwnMention,
} from '../src/groupAddressing.js';
import { ROSTER_CACHE_TTL_MS, createWhatsAppRosterProvider, rosterFromGroupMetadata } from '../src/roster.js';
import { OWN, textMessage } from './helpers.js';

const GROUP = '120363000000000000@g.us';
const ANNA = '4917111111111@s.whatsapp.net';

describe('group etiquette (spec 5.8): answer only when addressed', () => {
  it('ignores a plain message in a group', () => {
    const msg = textMessage({ jid: GROUP, participant: ANNA, text: 'Wer kommt heute?' });
    assert.equal(groupAddressing(msg, 'Wer kommt heute?', OWN), undefined);
  });

  it('answers a mention by phone JID or by LID', () => {
    for (const jid of [OWN.jid, OWN.lid]) {
      const msg = textMessage({ jid: GROUP, participant: ANNA, text: '@bot hi', mentioned: [jid] });
      assert.equal(groupAddressing(msg, '@bot hi', OWN), 'mention');
    }
  });

  it('does not treat a mention of somebody else as addressing the bot', () => {
    const msg = textMessage({ jid: GROUP, participant: ANNA, text: '@bob hi', mentioned: ['4917222222222@s.whatsapp.net'] });
    assert.equal(groupAddressing(msg, '@bob hi', OWN), undefined);
  });

  it('answers a reply to one of its own messages, not to somebody else\'s', () => {
    const toBot = textMessage({ jid: GROUP, participant: ANNA, text: '1', quotedParticipant: OWN.jid });
    assert.equal(groupAddressing(toBot, '1', OWN), 'reply_to_bot');
    const toBob = textMessage({ jid: GROUP, participant: ANNA, text: '1', quotedParticipant: '4917222222222@s.whatsapp.net' });
    assert.equal(groupAddressing(toBob, '1', OWN), undefined);
  });

  it('treats /agent as addressed even without a mention (the command is for the bot)', () => {
    for (const text of ['/agent', '/agent Mira', '/AGENT mira', '/agents', '/Agents']) {
      const msg = textMessage({ jid: GROUP, participant: ANNA, text });
      assert.equal(groupAddressing(msg, text, OWN), 'agent_command');
    }
    assert.equal(isAgentCommand('/agentur'), false);
  });

  it('strips the bot\'s own @mention so "@bot /agent Mira" reaches the kernel as "/agent Mira"', () => {
    const own = '4915100000000';
    assert.equal(stripOwnMention(`@${own} /agent Mira`, OWN), '/agent Mira');
    assert.equal(stripOwnMention('@99887766 /agent', OWN), '/agent');
    assert.equal(stripOwnMention('@4917222222222 hi', OWN), '@4917222222222 hi');
    const msg = textMessage({ jid: GROUP, participant: ANNA, text: `@${own} /agent Mira`, mentioned: [OWN.jid] });
    assert.equal(groupAddressing(msg, `@${own} /agent Mira`, OWN), 'mention');
  });
});

function source(overrides: Partial<Parameters<typeof createWhatsAppRosterProvider>[0]> = {}) {
  const calls: string[] = [];
  return {
    calls,
    src: {
      isConnected: () => true,
      ownIdentity: () => OWN,
      groupMetadata: async (jid: string) => {
        calls.push(jid);
        return {
          participants: [{ id: ANNA }, { id: '4917222222222@s.whatsapp.net', jid: '4917222222222@s.whatsapp.net' }, { id: OWN.jid }],
          size: 3,
        } as never;
      },
      ...overrides,
    },
  };
}

describe('conversation roster (audience floor)', () => {
  it('lists the members of a group as complete', async () => {
    const { src } = source();
    const roster = await createWhatsAppRosterProvider(src).getRoster(GROUP);
    assert.equal(roster?.status, 'complete');
    assert.equal(roster?.partial, false);
    assert.equal(roster?.conversationType, 'group');
    assert.deepEqual(roster?.participants.map((p) => p.userRef.id), [ANNA, '4917222222222@s.whatsapp.net', OWN.jid]);
    assert.equal(roster?.participants[0]?.userRef.kind, 'whatsapp-phone');
    assert.equal(roster?.self?.isBot, true);
  });

  it('reports a LID-addressed member with the phone form as externalId when WhatsApp gave it', () => {
    const roster = rosterFromGroupMetadata(
      { participants: [{ id: '123@lid', jid: ANNA }], size: 1 } as never,
      OWN,
      new Date(0),
    );
    assert.equal(roster.participants[0]?.userRef.id, '123@lid');
    assert.equal(roster.participants[0]?.externalId, ANNA);
  });

  it('is honest: fewer members listed than the group has is partial, none is unknown', () => {
    const partial = rosterFromGroupMetadata({ participants: [{ id: ANNA }], size: 5 } as never, OWN, new Date(0));
    assert.equal(partial.status, 'partial');
    assert.equal(partial.partial, true);
    const unknown = rosterFromGroupMetadata({ participants: [], size: 5 } as never, OWN, new Date(0));
    assert.equal(unknown.status, 'unknown');
  });

  it('returns unknown with the reason when WhatsApp refuses or the socket is down; never throws', async () => {
    const failing = source({ groupMetadata: async () => { throw new Error('forbidden'); } });
    const r1 = await createWhatsAppRosterProvider(failing.src).getRoster(GROUP);
    assert.equal(r1?.status, 'unknown');
    assert.match(r1?.statusDetail ?? '', /forbidden/);
    const down = source({ isConnected: () => false });
    const r2 = await createWhatsAppRosterProvider(down.src).getRoster(GROUP);
    assert.equal(r2?.status, 'unknown');
    assert.deepEqual(down.calls, []);
  });

  it('caches a complete roster briefly; fresh and invalidate bypass the cache', async () => {
    let now = 1_000_000;
    const { src, calls } = source();
    const provider = createWhatsAppRosterProvider(src, () => new Date(now));
    await provider.getRoster(GROUP);
    await provider.getRoster(GROUP);
    assert.equal(calls.length, 1);
    await provider.getRoster(GROUP, { fresh: true });
    assert.equal(calls.length, 2);
    provider.invalidate(GROUP);
    await provider.getRoster(GROUP);
    assert.equal(calls.length, 3);
    now += ROSTER_CACHE_TTL_MS + 1;
    await provider.getRoster(GROUP);
    assert.equal(calls.length, 4);
  });

  it('does not cache an unknown roster', async () => {
    let fail = true;
    const { src } = source({
      groupMetadata: async () => {
        if (fail) throw new Error('boom');
        return { participants: [{ id: ANNA }], size: 1 } as never;
      },
    });
    const provider = createWhatsAppRosterProvider(src);
    assert.equal((await provider.getRoster(GROUP))?.status, 'unknown');
    fail = false;
    assert.equal((await provider.getRoster(GROUP))?.status, 'complete');
  });

  it('a 1:1 chat is complete: the other person and the bot', async () => {
    const { src, calls } = source();
    const roster = await createWhatsAppRosterProvider(src).getRoster(ANNA);
    assert.equal(roster?.conversationType, 'direct');
    assert.equal(roster?.status, 'complete');
    assert.equal(roster?.participants.length, 1);
    assert.deepEqual(calls, []);
  });
});
