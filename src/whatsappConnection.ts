import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidGroup,
  makeCacheableSignalKeyStore,
  type ConnectionState,
  type MessageUpsertType,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys';
import type { Boom } from '@hapi/boom';
import QRCode from 'qrcode';

import type { IncomingTurn } from '@omadia/channel-sdk';
import type { MemoryAccessor } from '@omadia/plugin-api';

import { useMemoryAuthState } from './authState.js';
import { buildIncomingTurn, extractText, jidToPhone } from './inbound.js';
import { makeBaileysLogger, type BaileysLogger, type LogSink } from './logger.js';
import { patchState, type ChannelState } from './state.js';

export interface AccessPolicy {
  /** Stay silent in group chats. */
  ignoreGroups: boolean;
  /** Digits-only phone numbers allowed to chat (empty = allow all direct chats). */
  allowlist: Set<string>;
}

export interface WhatsAppConnectionDeps {
  channelId: string;
  memory: MemoryAccessor;
  log: LogSink;
  deviceName: string;
  state: ChannelState;
  policy: AccessPolicy;
  onMessage: (turn: IncomingTurn) => Promise<void>;
}

const RECONNECT_DELAY_MS = 3_000;

/**
 * Owns the long-lived WhatsApp Web (Baileys) socket: connect → emit QR →
 * linked → reconnect-on-drop. Drives the shared {@link ChannelState} so the
 * admin UI can render the pairing QR / connection status, and forwards each
 * inbound text message as an {@link IncomingTurn}.
 */
export class WhatsAppConnection {
  private sock: WASocket | undefined;
  private saveCreds: () => Promise<void> = async () => {};
  private authClearAll: () => Promise<void> = async () => {};
  private intentionalClose = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly logger: BaileysLogger;

  constructor(private readonly deps: WhatsAppConnectionDeps) {
    this.logger = makeBaileysLogger(deps.log);
  }

  /** Kick off the connection without blocking — QR + scan can far exceed the
   *  10s activate budget, so the socket drives state transitions in the
   *  background. */
  start(): void {
    void this.openSocket();
  }

  private async openSocket(): Promise<void> {
    if (this.intentionalClose) return;
    try {
      if (this.deps.state.status === 'starting') {
        patchState(this.deps.state, { status: 'connecting' });
      }

      const { state: authState, saveCreds, clearAll } = await useMemoryAuthState(this.deps.memory);
      this.saveCreds = saveCreds;
      this.authClearAll = clearAll;

      let version: [number, number, number] | undefined;
      try {
        version = (await fetchLatestBaileysVersion()).version;
      } catch (err) {
        this.deps.log('warn', 'could not fetch latest WhatsApp Web version, using bundled default', {
          error: (err as Error).message,
        });
      }

      const sock = makeWASocket({
        ...(version ? { version } : {}),
        logger: this.logger,
        auth: {
          creds: authState.creds,
          keys: makeCacheableSignalKeyStore(authState.keys, this.logger),
        },
        browser: [this.deps.deviceName, 'Chrome', '1.0.0'],
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
      });
      this.sock = sock;

      sock.ev.on('creds.update', () => void this.saveCreds());
      sock.ev.on('connection.update', (u) => void this.onConnectionUpdate(u));
      sock.ev.on('messages.upsert', (u) => void this.onMessagesUpsert(u));
    } catch (err) {
      this.deps.log('error', 'failed to open WhatsApp socket', { error: (err as Error).message });
      patchState(this.deps.state, { status: 'error', lastError: (err as Error).message });
      this.scheduleReconnect();
    }
  }

  private async onConnectionUpdate(update: Partial<ConnectionState>): Promise<void> {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        const qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
        patchState(this.deps.state, { status: 'qr', qrDataUrl, lastError: null });
        this.deps.log('info', 'WhatsApp pairing QR ready — scan it in the admin UI');
      } catch (err) {
        this.deps.log('error', 'failed to render pairing QR', { error: (err as Error).message });
      }
    }

    if (connection === 'open') {
      patchState(this.deps.state, {
        status: 'connected',
        qrDataUrl: null,
        lastError: null,
        me: { id: this.sock?.user?.id ?? '', ...(this.sock?.user?.name ? { name: this.sock.user.name } : {}) },
      });
      this.deps.log('info', 'WhatsApp connected', { id: this.sock?.user?.id });
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) {
        // Device was unlinked from the phone. Wipe stored auth so the next
        // connect produces a brand-new pairing QR rather than failing in a loop.
        this.deps.log('warn', 'WhatsApp device logged out — wiping auth, awaiting re-pair');
        patchState(this.deps.state, { status: 'logged_out', qrDataUrl: null, me: null });
        await this.authClearAll();
        this.scheduleReconnect();
      } else if (!this.intentionalClose) {
        patchState(this.deps.state, { status: 'connecting' });
        this.deps.log('info', 'WhatsApp connection closed, reconnecting', { statusCode });
        this.scheduleReconnect();
      }
    }
  }

  private async onMessagesUpsert(arg: { messages: WAMessage[]; type: MessageUpsertType }): Promise<void> {
    if (arg.type !== 'notify') return;
    for (const msg of arg.messages) {
      try {
        if (msg.key.fromMe) continue;
        const remoteJid = msg.key.remoteJid ?? '';
        if (!remoteJid || remoteJid === 'status@broadcast') continue;

        const isGroup = isJidGroup(remoteJid) ?? remoteJid.endsWith('@g.us');
        if (isGroup && this.deps.policy.ignoreGroups) continue;

        const text = extractText(msg);
        if (!text) continue;

        if (this.deps.policy.allowlist.size > 0) {
          const senderJid = isGroup ? (msg.key.participant ?? remoteJid) : remoteJid;
          if (!this.deps.policy.allowlist.has(jidToPhone(senderJid))) {
            this.deps.log('info', 'dropped WhatsApp message from non-allowlisted sender');
            continue;
          }
        }

        void this.sendTyping(remoteJid);
        await this.deps.onMessage(buildIncomingTurn(this.deps.channelId, msg, text));
      } catch (err) {
        this.deps.log('error', 'error handling inbound WhatsApp message', { error: (err as Error).message });
      }
    }
  }

  async sendText(jid: string, text: string): Promise<void> {
    if (!this.sock) throw new Error('WhatsApp socket not connected');
    await this.sock.sendMessage(jid, { text });
  }

  /** Best-effort "typing…" presence. Never throws into the caller. */
  async sendTyping(jid: string): Promise<void> {
    try {
      await this.sock?.sendPresenceUpdate('composing', jid);
    } catch {
      /* presence is cosmetic — ignore failures */
    }
  }

  /** Operator-initiated re-pair: unlink the device and come back with a fresh QR. */
  async logout(): Promise<void> {
    this.deps.log('info', 'operator requested WhatsApp re-pair (logout)');
    try {
      await this.sock?.logout();
      // The resulting `connection.update` (loggedOut) handler wipes auth and
      // schedules a reconnect that surfaces a new QR.
    } catch (err) {
      this.deps.log('warn', 'logout call failed; wiping local auth and restarting', {
        error: (err as Error).message,
      });
      await this.authClearAll();
      patchState(this.deps.state, { status: 'connecting', qrDataUrl: null, me: null });
      this.restart();
    }
  }

  private restart(): void {
    try {
      this.sock?.end(undefined);
    } catch {
      /* noop */
    }
    this.sock = undefined;
    void this.openSocket();
  }

  private scheduleReconnect(delayMs: number = RECONNECT_DELAY_MS): void {
    if (this.intentionalClose || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.openSocket();
    }, delayMs);
  }

  /** Release the socket + timers (ChannelHandle.close, 5s budget). */
  async close(): Promise<void> {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    try {
      this.sock?.end(undefined);
    } catch {
      /* noop */
    }
    this.sock = undefined;
  }
}
