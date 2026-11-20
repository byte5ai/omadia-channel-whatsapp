import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  InMemorySpeakerHistoryStore,
  REMOVED_DECORATIONS,
  admitDecorations,
  decorationsFor,
  type SemanticAnswer,
} from '@omadia/channel-sdk';

import { WHATSAPP_CHANNEL_TYPE, WHATSAPP_DECORATIONS, createAnswerEmitter, renderWhatsAppText } from '../src/emit.js';
import { mira } from './helpers.js';

describe('criterion 31: no undeclared decoration reaches the user', () => {
  it('every decoration this channel uses is declared for it in the registry', () => {
    const { admitted, refused } = admitDecorations(WHATSAPP_CHANNEL_TYPE, WHATSAPP_DECORATIONS);
    assert.equal(refused.length, 0);
    assert.deepEqual(admitted.map((d) => d.id), ['ai_disclosure_line']);
    const allowedByRegistry = decorationsFor(WHATSAPP_CHANNEL_TYPE).map((d) => d.id);
    assert.deepEqual(allowedByRegistry, ['ai_disclosure_line'], 'a text channel may only show the disclosure line');
  });

  it('the removed decorations (receipt reaction, footers, badges) are refused for WhatsApp', () => {
    const { admitted, refused } = admitDecorations(
      WHATSAPP_CHANNEL_TYPE,
      REMOVED_DECORATIONS.map((id) => ({ id })),
    );
    assert.equal(admitted.length, 0);
    assert.equal(refused.length, REMOVED_DECORATIONS.length);
    assert.ok(refused.some((r) => r.id === 'receipt_reaction' && r.reason === 'removed'));
  });

  it('an answer with every decorative field renders as the bare text', () => {
    const answer = {
      text: 'Der Auftrag ist angelegt.',
      speaker: mira,
      verifier: { status: 'verified' },
      disclaimer: 'unverified claims',
      followUps: [{ label: 'Mehr', prompt: 'Mehr bitte' }],
      agentsConsulted: [{ label: 'Jonas', status: 'success' }],
      memoryUsed: true,
      answerVerbosity: { effective: 'standard', source: 'configured' },
      oauthConsentPending: true,
      maskedValues: ['Anna'],
    } as unknown as SemanticAnswer;
    assert.equal(renderWhatsAppText(answer, 'c', new InMemorySpeakerHistoryStore()), 'Der Auftrag ist angelegt.');
  });

  it('the AI disclosure line (part of answer.text per the operator setting) is kept', () => {
    const text = 'Erledigt.\n\nDiese Antwort stammt von einer KI.';
    assert.equal(renderWhatsAppText({ text, speaker: mira }, 'c', new InMemorySpeakerHistoryStore()), text);
  });

  it('the emitter sends nothing but the rendered text', async () => {
    const sent: string[] = [];
    const emitter = createAnswerEmitter({
      sendText: async (_j, t) => void sent.push(t),
      speakerHistory: new InMemorySpeakerHistoryStore(),
    });
    await emitter.emit('j', { text: 'Hi', speaker: mira, followUps: [{ label: 'x', prompt: 'x' }], disclaimer: 'd' });
    assert.deepEqual(sent, ['Hi']);
  });

  it('the plugin sends no reaction and no decorative glyphs of its own', () => {
    const src = join(import.meta.dirname, '..', 'src');
    for (const file of readdirSync(src).filter((f) => f.endsWith('.ts'))) {
      // Comments may name the removed elements (to explain why they are gone).
      const text = readFileSync(join(src, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      assert.doesNotMatch(text, /react\s*:/, `${file} sends a reaction`);
      assert.doesNotMatch(text, /sendReaction|ACK_EMOJI/, `${file} still has the receipt reaction`);
      assert.doesNotMatch(text, /[👀💡⚠🖼📎]/u, `${file} contains a decorative emoji`);
    }
  });
});
