import type { SocketConfig } from '@whiskeysockets/baileys';

import type { LogLevel } from '@omadia/channel-sdk';

/** Sink matching `CoreApi.log` so Baileys' chatter can be funnelled into the
 *  channel-scoped logger. */
export type LogSink = (level: LogLevel, message: string, context?: Record<string, unknown>) => void;

/** Baileys' logger interface, derived from the socket config so we don't
 *  depend on the (version-unstable) named export. */
export type BaileysLogger = NonNullable<SocketConfig['logger']>;

/**
 * Build a Baileys-compatible (pino-shaped) logger that forwards only
 * `warn`/`error` to the host logger and drops `trace`/`debug`/`info`
 * (Baileys is extremely chatty at those levels). Pino call shapes are
 * `(obj, msg)` or `(msg)`; we normalise both into a single string + context.
 */
export function makeBaileysLogger(emit: LogSink): BaileysLogger {
  const forward =
    (level: LogLevel) =>
    (...args: unknown[]): void => {
      const { message, context } = normalise(args);
      emit(level, `[baileys] ${message}`, context);
    };

  const logger: BaileysLogger = {
    level: 'warn',
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: forward('warn'),
    error: forward('error'),
    // Baileys' ILogger does not require `child` to return a new instance —
    // a self-reference is fine since we hold no per-child bindings.
    child: () => logger,
  };
  return logger;
}

function normalise(args: unknown[]): { message: string; context?: Record<string, unknown> } {
  if (args.length === 0) return { message: '' };
  const [first, ...rest] = args;
  if (typeof first === 'object' && first !== null) {
    const msg = rest.find((a): a is string => typeof a === 'string') ?? '';
    return { message: msg, context: { detail: safeJson(first) } };
  }
  return { message: args.map(String).join(' ') };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
