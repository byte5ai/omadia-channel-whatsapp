import {
  type ChannelResolveResult,
  type ChannelRouteContext,
  type ChatAgent,
  type IncomingTurn,
} from '@omadia/channel-sdk';

/** What the platform decided for one turn: the part of {@link ChannelResolveResult} the channel acts on. */
export type TurnRoute = Pick<ChannelResolveResult, 'decision' | 'chatAgent' | 'notice' | 'speaker'>;

export interface TurnRouterDeps {
  /**
   * The platform's full routing result for `(whatsapp, channelKey)`
   * (`resolveChannelRoute`), looked up per turn so a hot config reload applies
   * at once; `undefined` when the platform publishes no resolver.
   */
  readonly resolve: (channelKey: string, context: ChannelRouteContext) => ChannelResolveResult | undefined;
  /**
   * The `chatAgent@1` singleton, read ONLY when the platform publishes no
   * resolver (a host without a multi-agent registry). With a resolver there is
   * no fallback agent (spec 2042 INV-7) and `chatAgent@1` is a refuser anyway:
   * a turn nobody answers for is rejected, never handed to the singleton.
   */
  readonly singleAgent: () => ChatAgent | undefined;
}

/**
 * The routing and selection key: the group JID for a group; for a direct chat
 * the phone-number JID as soon as WhatsApp reveals it (the same chat can be
 * addressed by number at one time and by privacy ID at another), else the
 * chat's own JID (LID). Send targets and the conversation id stay as WhatsApp
 * gives them; this key is also what a `channel_bindings` row must name.
 */
export function routeKeyOf(turn: IncomingTurn): string {
  const phone = turn.metadata?.['senderPhoneJid'];
  return turn.conversationType === 'direct' && typeof phone === 'string' && phone.length > 0
    ? phone
    : turn.conversationId;
}

/** The person's language (`de`/`en`) when the turn states one; WhatsApp messages carry none, so usually `undefined`. */
export function routeLocaleOf(turn: IncomingTurn): string | undefined {
  const raw = turn.metadata?.['locale'];
  if (typeof raw !== 'string') return undefined;
  const language = raw.trim().toLowerCase().split(/[-_]/)[0];
  return language === 'de' || language === 'en' ? language : undefined;
}

/**
 * Ask the platform who answers a turn. The routing key is {@link routeKeyOf}, the
 * tightest conversation key (a group, or the direct chat), and the selection
 * (`/agent`) hangs on it plus the sender's principal. The locale is passed only
 * when known; without it notices come in German. A resolver error is NOT
 * swallowed into a default agent; it fails the turn, and the user is told by a
 * `system` notice.
 */
export function createTurnRouter(deps: TurnRouterDeps): (turn: IncomingTurn, principal: string) => TurnRoute {
  return (turn, principal) => {
    const locale = routeLocaleOf(turn);
    const result = deps.resolve(routeKeyOf(turn), { principal, ...(locale ? { locale } : {}) });
    if (!result) {
      const singleAgent = deps.singleAgent();
      return { decision: 'bound', ...(singleAgent ? { chatAgent: singleAgent } : {}) };
    }
    return {
      decision: result.decision,
      ...(result.chatAgent ? { chatAgent: result.chatAgent } : {}),
      ...(result.notice ? { notice: result.notice } : {}),
      ...(result.speaker ? { speaker: result.speaker } : {}),
    };
  };
}
