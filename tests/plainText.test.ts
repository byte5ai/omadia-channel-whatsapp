import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InMemorySpeakerHistoryStore, type IncomingTurn, type SemanticAnswer } from '@omadia/channel-sdk';

import { createAnswerEmitter, renderWhatsAppText } from '../src/emit.js';
import { buildIncomingTurn } from '../src/inbound.js';
import { PersistentSpeakerHistoryStore } from '../src/speakerHistory.js';
import { createTurnHandler } from '../src/turnHandler.js';
import { boundRoute, fakeAgent, jonas, mira, textMessage } from './helpers.js';

function render(answer: SemanticAnswer, history = new InMemorySpeakerHistoryStore()): string {
  return renderWhatsAppText(answer, 'conv', history);
}

describe('speaker name line (INV-4)', () => {
  it('one agent in a conversation: never a name line', () => {
    const history = new InMemorySpeakerHistoryStore();
    assert.equal(render({ text: 'Hallo', speaker: mira }, history), 'Hallo');
    assert.equal(render({ text: 'Noch eins', speaker: mira }, history), 'Noch eins');
  });

  it('two agents: a name line where the speaker would otherwise be unclear', () => {
    const history = new InMemorySpeakerHistoryStore();
    render({ text: 'a', speaker: mira }, history);
    assert.equal(render({ text: 'b', speaker: jonas }, history), 'Jonas: b');
    assert.equal(render({ text: 'c', speaker: mira }, history), 'Mira: c');
  });

  it('the history survives a restart', async () => {
    const files = new Map<string, string>();
    const memory = {
      exists: async (p: string) => files.has(p),
      readFile: async (p: string) => files.get(p)!,
      writeFile: async (p: string, c: string) => void files.set(p, c),
    } as never;
    const before = new PersistentSpeakerHistoryStore(memory);
    render({ text: 'a', speaker: mira }, before);
    await before.flush();

    const after = new PersistentSpeakerHistoryStore(memory);
    await after.load();
    assert.equal(render({ text: 'b', speaker: jonas }, after), 'Jonas: b');
  });
});

describe('criteria 29/30: plain text and channel parity', () => {
  it('a consultation shows the contribution attributed in plain text, failed ones too', () => {
    const text = render({
      text: 'Ich habe Jonas gefragt.',
      speaker: mira,
      contributions: [
        { id: 'c1', speaker: jonas, text: 'Das Budget reicht.', status: 'delivered' },
        { id: 'c2', speaker: jonas, text: 'Jonas konnte nicht antworten.', status: 'failed' },
      ],
    });
    assert.equal(text, 'Ich habe Jonas gefragt.\n\nJonas: Das Budget reicht.\n\nJonas: Jonas konnte nicht antworten.');
  });

  it('a system notice is its own text, under no agent name, even in a multi-agent conversation', () => {
    const history = new InMemorySpeakerHistoryStore();
    render({ text: 'a', speaker: mira }, history);
    render({ text: 'b', speaker: jonas }, history);
    const text = render(
      {
        text: 'ignored',
        speaker: { kind: 'system' },
        systemNotice: { code: 'agent_selected', text: 'Du sprichst jetzt mit Mira.', locale: 'de' },
      },
      history,
    );
    assert.equal(text, 'Du sprichst jetzt mit Mira.');
  });

  it('a choice card degrades to numbered text', () => {
    const text = render({
      text: 'Welche Variante?',
      speaker: mira,
      interactive: {
        kind: 'choice',
        question: 'Bitte wählen',
        options: [
          { label: 'Variante A', prompt: 'A' },
          { label: 'Variante B', prompt: 'B' },
        ],
      } as never,
    });
    assert.equal(text, 'Welche Variante?\n\nBitte wählen\n1) Variante A\n2) Variante B');
  });

  it('attachments are plain "label: url" lines without icons', () => {
    const text = render({
      text: 'Hier.',
      speaker: mira,
      attachments: [{ kind: 'image', altText: 'Diagramm', url: 'https://x.test/a.png' } as never],
    });
    assert.equal(text, 'Hier.\n\nDiagramm: https://x.test/a.png');
  });

  it('choosing an agent works as plain text: /agent reaches the kernel verbatim, the notice comes back', async () => {
    for (const command of ['/agent', '/agent Mira']) {
      const msg = textMessage({ jid: '4917@s.whatsapp.net', text: command });
      const incoming: IncomingTurn = buildIncomingTurn('wa', msg, command);
      assert.equal(incoming.text, command);

      const agent = fakeAgent([
        {
          text: 'x',
          speaker: { kind: 'system' },
          systemNotice: { code: 'agent_selected', text: 'Du sprichst jetzt mit Mira.', locale: 'de' },
        },
      ]);
      const sent: string[] = [];
      const handler = createTurnHandler({
        route: boundRoute(agent),
        emitter: createAnswerEmitter({
          sendText: async (_j, t) => void sent.push(t),
          speakerHistory: new InMemorySpeakerHistoryStore(),
        }),
        log: () => {},
      });
      await handler.handle(incoming);
      assert.equal(agent.inputs[0]!['userMessage'], command);
      assert.deepEqual(sent, ['Du sprichst jetzt mit Mira.']);
    }
  });

  it('a group turn is marked as group, a 1:1 as direct', () => {
    const group = buildIncomingTurn('wa', textMessage({ jid: '1203@g.us', participant: '4917@s.whatsapp.net', text: 'hi' }), 'hi');
    assert.equal(group.conversationType, 'group');
    assert.equal(group.userRef.id, '4917@s.whatsapp.net');
    const direct = buildIncomingTurn('wa', textMessage({ jid: '4917@s.whatsapp.net', text: 'hi' }), 'hi');
    assert.equal(direct.conversationType, 'direct');
  });
});
