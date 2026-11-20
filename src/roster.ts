import { jidNormalizedUser, type GroupMetadata } from '@whiskeysockets/baileys';

import {
  type ConversationParticipant,
  type ConversationRoster,
  type ConversationRosterProvider,
  type ConversationRosterRequest,
} from '@omadia/channel-sdk';

import { WHATSAPP_CHANNEL_TYPE } from './emit.js';
import type { OwnIdentity } from './groupAddressing.js';

/** Group membership changes rarely mid-conversation; a short cache keeps a chatty group cheap. */
export const ROSTER_CACHE_TTL_MS = 30_000;

/** The socket calls the roster needs. Implemented by `WhatsAppConnection`. */
export interface RosterSource {
  isConnected(): boolean;
  ownIdentity(): OwnIdentity;
  groupMetadata(groupJid: string): Promise<GroupMetadata>;
}

const PARTICIPANT_KIND = 'whatsapp-phone' as const;

/**
 * `id` is what WhatsApp addresses the member by in this group (phone JID or
 * privacy LID, the same form `key.participant` carries on their messages).
 * `phoneJid` is the phone-number form when WhatsApp also gave it.
 */
function participantOf(jid: string, phoneJid?: string): ConversationParticipant {
  const id = jidNormalizedUser(jid);
  return {
    userRef: { kind: PARTICIPANT_KIND, id },
    ...(phoneJid && jidNormalizedUser(phoneJid) !== id ? { externalId: jidNormalizedUser(phoneJid) } : {}),
  };
}

function selfParticipant(own: OwnIdentity): ConversationParticipant | undefined {
  const id = own.jid || own.lid;
  return id ? { userRef: { kind: PARTICIPANT_KIND, id }, isBot: true } : undefined;
}

/**
 * Translate Baileys group metadata into the SDK roster, honest about what was
 * read: `complete` only when the platform listed as many members as the group
 * has; `partial` when it listed fewer; `unknown` when it listed none.
 */
export function rosterFromGroupMetadata(
  meta: Pick<GroupMetadata, 'participants' | 'size'>,
  own: OwnIdentity,
  readAt: Date,
): ConversationRoster {
  const self = selfParticipant(own);
  const base = { conversationType: 'group' as const, ...(self ? { self } : {}), readAt: readAt.toISOString() };
  const listed = meta.participants ?? [];
  if (listed.length === 0) {
    return {
      ...base,
      participants: [],
      partial: true,
      status: 'unknown',
      statusDetail: 'WhatsApp returned no group members',
    };
  }
  const participants = listed.map((p) => participantOf(p.id, p.jid));
  const isShort = typeof meta.size === 'number' && meta.size > listed.length;
  return isShort
    ? {
        ...base,
        participants,
        partial: true,
        status: 'partial',
        statusDetail: `WhatsApp listed ${String(listed.length)} of ${String(meta.size)} members`,
      }
    : { ...base, participants, partial: false, status: 'complete' };
}

function unknownRoster(conversationType: 'group' | 'direct', readAt: Date, detail: string): ConversationRoster {
  return {
    conversationType,
    participants: [],
    partial: true,
    status: 'unknown',
    readAt: readAt.toISOString(),
    statusDetail: detail,
  };
}

/**
 * Roster provider for the kernel's audience floor (`registerRosterProvider`).
 * Group membership comes from Baileys `groupMetadata`; a failure is returned
 * as an `unknown` roster with the reason, never thrown and never guessed. A
 * 1:1 chat is `complete`: the sender and the linked account.
 */
export function createWhatsAppRosterProvider(
  source: RosterSource,
  now: () => Date = () => new Date(),
): ConversationRosterProvider & { invalidate(groupJid: string): void } {
  const cache = new Map<string, { roster: ConversationRoster; at: number }>();

  return {
    channelType: WHATSAPP_CHANNEL_TYPE,

    invalidate(groupJid) {
      cache.delete(groupJid);
    },

    async getRoster(conversationId: string, opts?: ConversationRosterRequest) {
      const readAt = now();
      const own = source.ownIdentity();
      if (!conversationId.endsWith('@g.us')) {
        const self = selfParticipant(own);
        return {
          conversationType: 'direct',
          participants: [participantOf(conversationId)],
          ...(self ? { self } : {}),
          partial: false,
          status: 'complete',
          readAt: readAt.toISOString(),
        } satisfies ConversationRoster;
      }

      const cached = cache.get(conversationId);
      if (!opts?.fresh && cached && readAt.getTime() - cached.at < ROSTER_CACHE_TTL_MS) {
        return cached.roster;
      }
      if (!source.isConnected()) {
        return unknownRoster('group', readAt, 'WhatsApp is not connected');
      }
      try {
        const roster = rosterFromGroupMetadata(await source.groupMetadata(conversationId), own, readAt);
        if (roster.status === 'complete') cache.set(conversationId, { roster, at: readAt.getTime() });
        return roster;
      } catch (err) {
        return unknownRoster('group', readAt, `group members could not be read: ${(err as Error).message}`);
      }
    },
  };
}
