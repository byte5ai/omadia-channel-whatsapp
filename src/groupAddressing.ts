import { jidNormalizedUser, type WAMessage } from '@whiskeysockets/baileys';

/** The WhatsApp identities of the linked account (phone-number JID and privacy LID). */
export interface OwnIdentity {
  readonly jid: string;
  readonly lid: string;
}

/**
 * The agent commands: `/agent <Name>` selects, `/agent` alone clears the
 * selection, `/agents` lists the available agents. The ChatAgent the channel
 * resolver returns carries them out; this plugin only recognises the prefix so
 * a group message that starts with one counts as addressed to the bot.
 */
const AGENT_COMMAND = /^\/agents?(?:\s|$)/i;

export function isAgentCommand(text: string): boolean {
  return AGENT_COMMAND.test(text.trim());
}

interface ContextInfoLike {
  mentionedJid?: string[] | null;
  participant?: string | null;
  quotedMessage?: unknown;
}

/** The `contextInfo` of whichever message kind carries one (text, caption, reply). */
export function contextInfoOf(msg: WAMessage): ContextInfoLike | undefined {
  const message = msg.message as Record<string, unknown> | null | undefined;
  if (!message) return undefined;
  for (const value of Object.values(message)) {
    if (value && typeof value === 'object' && 'contextInfo' in value) {
      const info = (value as { contextInfo?: ContextInfoLike | null }).contextInfo;
      if (info) return info;
    }
  }
  return undefined;
}

function matchesOwn(jid: string | null | undefined, own: OwnIdentity): boolean {
  if (!jid) return false;
  const normalised = jidNormalizedUser(jid);
  return (own.jid !== '' && normalised === own.jid) || (own.lid !== '' && normalised === own.lid);
}

export type GroupAddressing = 'mention' | 'reply_to_bot' | 'agent_command';

/**
 * Team etiquette (spec 2042 §5.8): in a group the bot speaks only when it is
 * addressed — @mentioned, replied to, or given the `/agent` command — never on
 * every message. Returns how it was addressed, or `undefined`.
 */
export function groupAddressing(msg: WAMessage, text: string, own: OwnIdentity): GroupAddressing | undefined {
  const info = contextInfoOf(msg);
  if ((info?.mentionedJid ?? []).some((jid) => matchesOwn(jid, own))) return 'mention';
  if (info?.quotedMessage && matchesOwn(info.participant, own)) return 'reply_to_bot';
  if (isAgentCommand(stripOwnMention(text, own))) return 'agent_command';
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function userPart(jid: string): string {
  return jid.split('@')[0]?.split(':')[0] ?? '';
}

/**
 * Remove the bot's own `@mention` token from a group message so
 * "@Omadia /agent Mira" reaches the kernel as the plain text `/agent Mira`.
 * Other mentions are left untouched.
 */
export function stripOwnMention(text: string, own: OwnIdentity): string {
  const users = [own.jid, own.lid].map(userPart).filter((u) => u.length > 0);
  if (users.length === 0) return text.trim();
  const token = new RegExp(`@(?:${users.map(escapeRegExp).join('|')})\\b`, 'g');
  return text.replace(token, ' ').replace(/\s+/g, ' ').trim();
}
