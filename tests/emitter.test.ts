import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { InMemorySpeakerHistoryStore, type IncomingTurn, type SemanticAnswer } from '@omadia/channel-sdk';

import {
  MissingSpeakerError,
  createAnswerEmitter,
  type AnswerEmitter,
} from '../src/emit.js';
import {
  GROUP_ROSTER_UNAVAILABLE_TEXT,
  REFUSAL_NOTICE_WINDOW_MS,
  TURN_FAILED_TEXT,
  createTurnHandler,
} from '../src/turnHandler.js';
import { fakeAgent, mira } from './helpers.js';

const SRC = join(import.meta.dirname, '..', 'src');
const sources = readdirSync(SRC)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => ({ file: f, text: readFileSync(join(SRC, f), 'utf8') }));

function turn(text = 'Hallo'): IncomingTurn {
  return {
    channelId: 'wa',
    conversationId: '4917@s.whatsapp.net',
    userRef: { kind: 'whatsapp-phone', id: '4917@s.whatsapp.net' },
    conversationType: 'direct',
    text,
  };
}

/** An emitter that records the speaker of everything sent through it. */
function recordingEmitter() {
  const sent: Array<{ jid: string; text: string }> = [];
  const speakers: Array<SemanticAnswer['speaker']> = [];
  const inner = createAnswerEmitter({
    sendText: async (jid, text) => void sent.push({ jid, text }),
    speakerHistory: new InMemorySpeakerHistoryStore(),
  });
  const emitter: AnswerEmitter = {
    emit: (jid, answer) => {
      speakers.push(answer.speaker);
      return inner.emit(jid, answer);
    },
  };
  return { emitter, sent, speakers };
}

describe('criterion 5: every WhatsApp output carries a speaker (agent or system)', () => {
  it('has exactly one path to the socket: sendMessage in sendText, which only the emitter is given', () => {
    const rawSends = sources.filter((s) => /\.sendMessage\(/.test(s.text));
    assert.deepEqual(rawSends.map((s) => s.file), ['whatsappConnection.ts']);
    assert.equal(
      (rawSends[0]!.text.match(/\.sendMessage\(/g) ?? []).length,
      1,
      'the connection has exactly one sendMessage call (in sendText)',
    );
    // `sendText` is called as `deps.sendText(...)` in emit.ts only; plugin.ts merely hands the
    // primitive to the emitter as a dependency.
    const callSites = sources.flatMap((s) =>
      (s.text.match(/[.\w]*\bsendText\(/g) ?? [])
        .filter((call) => call !== 'sendText(' || !/async sendText\(/.test(s.text))
        .map((call) => `${s.file}:${call}`),
    );
    assert.deepEqual(callSites.sort(), ['emit.ts:deps.sendText(', 'plugin.ts:conn.sendText(']);
    const pluginText = sources.find((s) => s.file === 'plugin.ts')!.text;
    assert.match(pluginText, /createAnswerEmitter\(\{\s*sendText: \(jid, text\) => conn\.sendText\(jid, text\)/);
  });

  it('refuses to send an answer without a speaker', async () => {
    const { emitter, sent } = recordingEmitter();
    await assert.rejects(emitter.emit('j', { text: 'unattributed' }), MissingSpeakerError);
    assert.equal(sent.length, 0);
  });

  it('agent answer, failure notice and refusal notice all carry a speaker', async () => {
    const { emitter, sent, speakers } = recordingEmitter();
    const logs: string[] = [];
    let clock = 0;
    const handler = createTurnHandler({
      agentFor: () => fakeAgent([{ text: 'Erledigt.', speaker: mira }]),
      emitter,
      log: (_l, m) => void logs.push(m),
      now: () => clock,
    });

    await handler.handle(turn());
    assert.equal(speakers.at(-1)?.kind, 'agent');

    const failing = createTurnHandler({
      agentFor: () => fakeAgent([]), // chat() throws
      emitter,
      log: (_l, m) => void logs.push(m),
    });
    await failing.handle(turn());
    assert.deepEqual(speakers.at(-1), { kind: 'system' });
    assert.equal(sent.at(-1)?.text, TURN_FAILED_TEXT);

    await handler.refuse(turn(), 'group_roster_unavailable');
    assert.deepEqual(speakers.at(-1), { kind: 'system' });
    assert.equal(sent.at(-1)?.text, GROUP_ROSTER_UNAVAILABLE_TEXT);

    assert.ok(speakers.every((s) => s !== undefined), 'no emission without a speaker');
    assert.equal(sent.length, 3);

    // one refusal notice per conversation per window
    await handler.refuse(turn(), 'group_roster_unavailable');
    assert.equal(sent.length, 3);
    clock += REFUSAL_NOTICE_WINDOW_MS + 1;
    await handler.refuse(turn(), 'group_roster_unavailable');
    assert.equal(sent.length, 4);
  });

  it('tells the user when the kernel delivers an answer without a speaker (fail loud, nothing unattributed)', async () => {
    const { emitter, sent, speakers } = recordingEmitter();
    const handler = createTurnHandler({
      agentFor: () => fakeAgent([{ text: 'no speaker here' }]),
      emitter,
      log: () => {},
    });
    await handler.handle(turn());
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.text, TURN_FAILED_TEXT);
    assert.deepEqual(speakers.at(-1), { kind: 'system' });
  });

  it('stays silent on NO_REPLY', async () => {
    const { emitter, sent } = recordingEmitter();
    const handler = createTurnHandler({
      agentFor: () => fakeAgent([{ text: 'NO_REPLY', speaker: mira }]),
      emitter,
      log: () => {},
    });
    await handler.handle(turn());
    assert.equal(sent.length, 0);
  });

  it('hands the kernel the conversation context: origin with group statement, user, scope', async () => {
    const { emitter } = recordingEmitter();
    const agent = fakeAgent([{ text: 'ok', speaker: mira }]);
    const handler = createTurnHandler({ agentFor: () => agent, emitter, log: () => {} });
    await handler.handle({ ...turn('/agent Mira'), conversationId: '1203@g.us', conversationType: 'group' });
    const input = agent.inputs[0]!;
    assert.equal(input['userMessage'], '/agent Mira');
    assert.equal(input['sessionScope'], 'whatsapp:1203@g.us');
    const origin = input['origin'] as Record<string, unknown>;
    assert.equal(origin['channelType'], 'whatsapp');
    assert.equal(origin['conversationType'], 'group');
    assert.equal(origin['channelConversationId'], '1203@g.us');
  });
});
