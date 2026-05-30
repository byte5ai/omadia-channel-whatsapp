import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as channelSdk from '@omadia/channel-sdk';
import {
  isNoReply,
  logNoReplyDrop,
  type ChatAgent,
  type ChannelHandle,
  type CoreApi,
  type IncomingTurn,
} from '@omadia/channel-sdk';
import type { PluginContext } from '@omadia/plugin-api';

import { createAdminRouter } from './adminRouter.js';
import { renderAnswer } from './renderer.js';
import { createChannelState } from './state.js';
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

  // Resolve the orchestrator's ChatAgent. Prefers the SDK's getChatAgent()
  // helper; falls back to the raw 'chatAgent' service lookup so the plugin
  // still runs on a host whose channel-sdk predates the helper.
  const agent = resolveChatAgent(ctx);
  if (!agent) {
    throw new Error(
      '@omadia/channel-whatsapp: orchestrator unavailable (getChatAgent) — the orchestrator plugin must be installed and active',
    );
  }

  const state = createChannelState();

  // `let conn!` so the onMessage closure can reference the instance it is
  // attached to; the closure only fires once messages arrive (long after
  // construction), by which time `conn` is assigned.
  let conn!: WhatsAppConnection;
  conn = new WhatsAppConnection({
    channelId,
    memory: ctx.memory,
    log: (level, message, context) => core.log(level, message, context),
    deviceName,
    state,
    policy: { ignoreGroups, allowlist },
    onMessage: (turn) => handleTurn(agent, core, conn, turn),
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
    },
  };
}

/** Drive one orchestrator turn and ship the rendered answer back to WhatsApp. */
async function handleTurn(
  agent: ChatAgent,
  core: CoreApi,
  conn: WhatsAppConnection,
  turn: IncomingTurn,
): Promise<void> {
  try {
    const answer = await agent.chat({
      userMessage: turn.text,
      sessionScope: `whatsapp:${turn.conversationId}`,
      userId: turn.userRef.id,
    });
    if (isNoReply(answer)) {
      logNoReplyDrop(turn.channelId, { conversationId: turn.conversationId });
      return;
    }
    const text = renderAnswer(answer);
    if (text.trim().length === 0) return;
    await conn.sendText(turn.conversationId, text);
  } catch (err) {
    core.log('error', 'failed to handle WhatsApp turn', {
      error: (err as Error).message,
      conversationId: turn.conversationId,
    });
    try {
      await conn.sendText(
        turn.conversationId,
        '⚠️ Entschuldigung, dabei ist ein Fehler aufgetreten. Bitte versuche es erneut.',
      );
    } catch {
      /* original error already logged — don't mask it with a send failure */
    }
  }
}

/**
 * Resolve the orchestrator's {@link ChatAgent}. Prefers the SDK helper
 * `getChatAgent(ctx)` (the blessed, typed path); falls back to the raw
 * service-registry lookup so the plugin also runs on a host whose
 * `@omadia/channel-sdk` predates the helper (the `chatAgent` service itself
 * has always been there). Accessed via the namespace so a missing export is
 * just `undefined` at runtime rather than a module-load error.
 */
function resolveChatAgent(ctx: PluginContext): ChatAgent | undefined {
  const helper = (channelSdk as { getChatAgent?: (c: PluginContext) => ChatAgent | undefined })
    .getChatAgent;
  if (helper) return helper(ctx);
  return ctx.services.get<{ agent: ChatAgent }>('chatAgent')?.agent;
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
