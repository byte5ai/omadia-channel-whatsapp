import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getChatAgent,
  resolveChannelRoute,
  rosterStatusOf,
  type ChatAgent,
  type ChannelHandle,
  type CoreApi,
  type IncomingTurn,
} from '@omadia/channel-sdk';
import type { PluginContext } from '@omadia/plugin-api';

import { createAdminRouter } from './adminRouter.js';
import { createMessageEvents, whatsAppInstallationKey, type DeliveryMode } from './conversationMessages.js';
import { WHATSAPP_CHANNEL_TYPE, createAnswerEmitter } from './emit.js';
import { createWhatsAppRosterProvider } from './roster.js';
import { createWhatsAppSendProviders } from './sendProviders.js';
import { PersistentSpeakerHistoryStore } from './speakerHistory.js';
import { createTurnRouter } from './routing.js';
import { createChannelState } from './state.js';
import { createTurnHandler } from './turnHandler.js';
import { WhatsAppConnection } from './whatsappConnection.js';

/**
 * Channel-plugin entry. The kernel's dynamic channel resolver imports this
 * module and calls the exported `activate(ctx, core)` (ChannelPlugin "shape
 * 1"). We open the WhatsApp Web socket in the background, mount the QR admin
 * UI, and return a handle the kernel closes on deactivate/uninstall.
 */
export async function activate(ctx: PluginContext, core: CoreApi): Promise<ChannelHandle> {
  if (!ctx.memory) {
    throw new Error(
      '@omadia/channel-whatsapp requires ctx.memory for auth-state persistence — declare permissions.memory in the manifest',
    );
  }

  const channelId = ctx.agentId;
  const deviceName = ctx.config.get<string>('device_name') ?? 'Omadia';
  const ignoreGroups = ctx.config.get<boolean>('ignore_groups') ?? true;
  const allowlist = parseAllowlist(ctx.config.get<string>('allowlist') ?? '');

  const state = createChannelState();

  // `let conn!` so the closures below can reference the instance they are
  // attached to; they only fire once messages arrive (long after
  // construction), by which time `conn` is assigned.
  let conn!: WhatsAppConnection;

  // One identity per installation (one linked number), so the plain name line
  // (INV-4) is what tells several agents apart. The history survives restarts.
  const speakerHistory = new PersistentSpeakerHistoryStore(
    ctx.memory.pluginWide ?? ctx.memory,
    (message, error) => core.log('warn', message, { error: (error as Error).message }),
  );
  await speakerHistory.load();

  const emitter = createAnswerEmitter({
    sendText: (jid, text) => conn.sendText(jid, text),
    speakerHistory,
    onDecorationRefused: (refusal) =>
      core.log('error', 'WhatsApp decoration refused by the registry', { ...refusal }),
  });
  const turns = createTurnHandler({
    // The platform's channelResolver decides per turn and per sender (bound
    // agent + speaker, or reject + notice); there is no fallback agent. The
    // chatAgent@1 singleton is read only when no resolver is published.
    route: createTurnRouter({
      resolve: (channelKey, context) => resolveChannelRoute(ctx, WHATSAPP_CHANNEL_TYPE, channelKey, context),
      singleAgent: () => resolveSingleAgent(ctx),
    }),
    emitter,
    sendTyping: (jid) => conn.sendTyping(jid),
    log: (level, message, context) => core.log(level, message, context),
  });

  // Polls and question cards: the kernel posts them as numbered text through
  // `sendToConversation` and turns a typed reply into the `card_answer` from the
  // `created` events below (replyToMessageId / addressedToBot). No card code here.
  const delivery = deliveryModeOf(core);
  const messageEvents = createMessageEvents({
    channelId,
    emit: typeof core.emitConversationMessage === 'function' ? (event) => core.emitConversationMessage?.(event) : undefined,
    delivery,
    installationKey: () => whatsAppInstallationKey(conn.ownIdentity()),
    log: (level, message, context) => core.log(level, message, context),
  });
  // Feature-detect: kernels without the send seams simply never get providers.
  const sendProviders = createWhatsAppSendProviders({ emitter, policy: { ignoreGroups, allowlist } });
  if (typeof core.registerTargetedSendProvider === 'function') {
    core.registerTargetedSendProvider(channelId, sendProviders.targeted);
  }
  if (typeof core.registerConversationSendProvider === 'function') {
    core.registerConversationSendProvider(channelId, sendProviders.conversation);
  }

  const roster = createWhatsAppRosterProvider({
    isConnected: () => conn.isConnected(),
    ownIdentity: () => conn.ownIdentity(),
    groupMetadata: (groupJid) => conn.groupMetadata(groupJid),
  });
  // Feature-detect: kernels that predate the roster seam simply never get a
  // provider and keep treating every conversation as direct.
  if (typeof core.registerRosterProvider === 'function') {
    core.registerRosterProvider(channelId, roster);
  } else {
    core.log('warn', 'kernel has no registerRosterProvider — groups cannot be audience-checked');
  }

  conn = new WhatsAppConnection({
    channelId,
    memory: ctx.memory,
    log: (level, message, context) => core.log(level, message, context),
    deviceName,
    state,
    policy: { ignoreGroups, allowlist },
    onMessage: async (turn: IncomingTurn, addressing) => {
      // The kernel gets the message first (a typed answer to a poll becomes its
      // card_answer there). Where it reads everything for a facilitation the
      // engine drives the conversation and the channel starts no turn.
      if (messageEvents.created(turn, addressing) === 'all') return;
      await turns.handle(turn);
    },
    onObserved: (turn) => void messageEvents.created(turn, undefined),
    onRefused: (turn, reason) => turns.refuse(turn, reason),
    // A group is answered only when its members are readable. `partial` goes
    // on to the kernel, whose audience floor fails closed on it.
    canAnswerGroup: async (groupJid) =>
      rosterStatusOf((await roster.getRoster(groupJid, { fresh: true })) ?? { partial: true, status: 'unknown' }) !==
      'unknown',
    onGroupMembershipChanged: (groupJid) => roster.invalidate(groupJid),
  });

  // QR / status admin UI. web-ui renders this as an iframe (manifest
  // `admin_ui_path`); the UI fetches its JSON API with RELATIVE paths so it
  // resolves through the `/bot-api` rewrite.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const uiAssetsPath = path.resolve(here, '../assets/admin-ui');
  const disposeRoutes = ctx.routes.register(
    '/api/whatsapp-channel/admin',
    createAdminRouter({
      uiAssetsPath,
      state,
      smokeMode: ctx.smokeMode,
      onLogout: () => conn.logout(),
    }),
  );

  // Non-blocking — QR + scan can far exceed the 10s activate budget.
  conn.start();

  core.log('info', 'WhatsApp channel activated — open the admin UI to scan the pairing QR', {
    adminUi: '/api/whatsapp-channel/admin/index.html',
    ignoreGroups,
    allowlisted: allowlist.size,
  });

  return {
    async close() {
      disposeRoutes();
      await conn.close();
      await speakerHistory.flush();
    },
  };
}

/**
 * The `chatAgent@1` singleton: the answer path of a host WITHOUT a channel
 * resolver only. With a resolver it is never read (it refuses every non-canvas
 * turn there), so no resolver result is ever overridden by it.
 */
function resolveSingleAgent(ctx: PluginContext): ChatAgent | undefined {
  return getChatAgent(ctx);
}

/**
 * What the kernel wants of a conversation: `conversationDelivery` where it has
 * it, else `isAllMessagesSubscribed` (all or none); `undefined` when neither.
 */
function deliveryModeOf(
  core: CoreApi,
): ((conversationId: string, channelKey: string) => DeliveryMode) | undefined {
  if (typeof core.conversationDelivery === 'function') {
    return (conversationId, channelKey) =>
      core.conversationDelivery?.(WHATSAPP_CHANNEL_TYPE, conversationId, channelKey) ?? 'none';
  }
  if (typeof core.isAllMessagesSubscribed === 'function') {
    return (conversationId, channelKey) =>
      core.isAllMessagesSubscribed?.(WHATSAPP_CHANNEL_TYPE, conversationId, channelKey) ? 'all' : 'none';
  }
  return undefined;
}

/** Parse the comma-separated allowlist into digits-only phone numbers. */
function parseAllowlist(raw: string): Set<string> {
  return new Set(
    raw
      .split(',')
      .map((entry) => entry.replace(/\D/g, ''))
      .filter((entry) => entry.length > 0),
  );
}
