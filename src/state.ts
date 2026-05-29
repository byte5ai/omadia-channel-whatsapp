/**
 * Shared, in-memory channel state. A single instance is created in
 * `activate()` and read by the admin router (to render the QR / status) and
 * written by the WhatsApp connection (on every `connection.update`).
 *
 * It is intentionally a plain mutable object — there is exactly one writer
 * (the Baileys event loop) and N readers (admin-UI poll requests), and the
 * fields are independent scalars, so no locking is needed.
 */

export type ConnectionStatus =
  | 'starting' // activate() called, socket not yet created
  | 'connecting' // socket open, handshaking / reconnecting
  | 'qr' // waiting for the operator to scan the QR
  | 'connected' // linked + online
  | 'logged_out' // device unlinked from the phone — needs a fresh scan
  | 'error'; // unexpected fatal error (see lastError)

export interface ChannelState {
  status: ConnectionStatus;
  /** PNG data-URL of the current pairing QR, or null when none is pending. */
  qrDataUrl: string | null;
  /** The linked WhatsApp identity once connected (e.g. "Bot · 49170…"). */
  me: { id: string; name?: string } | null;
  /** Last error message surfaced to the operator, or null. */
  lastError: string | null;
  /** Epoch-ms of the last state transition — lets the UI show "x s ago". */
  updatedAt: number;
}

export function createChannelState(): ChannelState {
  return {
    status: 'starting',
    qrDataUrl: null,
    me: null,
    lastError: null,
    updatedAt: Date.now(),
  };
}

/** Apply a partial update and bump `updatedAt` in one place. */
export function patchState(state: ChannelState, patch: Partial<ChannelState>): void {
  Object.assign(state, patch);
  state.updatedAt = Date.now();
}
