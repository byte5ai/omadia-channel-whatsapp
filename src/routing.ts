import {
  CHANNEL_RESOLVER_SERVICE,
  type ChannelBindingResolver,
  type ChannelResolveResult,
  type ChatAgent,
  type IncomingTurn,
} from '@omadia/channel-sdk';
import type { PluginContext } from '@omadia/plugin-api';

import { WHATSAPP_CHANNEL_TYPE } from './emit.js';

/** What the platform decided for one turn: the part of {@link ChannelResolveResult} the channel acts on. */
export type TurnRoute = Pick<ChannelResolveResult, 'decision' | 'chatAgent' | 'notice' | 'speaker'>;

export interface TurnRouterDeps {
  /** The platform's channel resolver, looked up per turn (a hot config reload applies at once). */
  readonly resolver: () => ChannelBindingResolver | undefined;
  /**
   * The deployment's orchestrator, used ONLY when the platform publishes no
   * resolver (a minimal, single-orchestrator deployment). With a resolver
   * there is no fallback agent (spec 2042 INV-7): a turn nobody answers for is
   * refused, never handed to the shared orchestrator.
   */
  readonly singleAgent: ChatAgent | undefined;
}

/**
 * Ask the platform who answers a turn: the conversation is the routing key,
 * the sender's principal lets it apply selections and availability. A resolver
 * error is NOT swallowed into a default agent; it fails the turn, and the user
 * is told by a `system` notice.
 */
export function createTurnRouter(deps: TurnRouterDeps): (turn: IncomingTurn, principal: string) => TurnRoute {
  return (turn, principal) => {
    const resolver = deps.resolver();
    if (!resolver) {
      return { decision: 'bound', ...(deps.singleAgent ? { chatAgent: deps.singleAgent } : {}) };
    }
    const result = resolver.resolve(WHATSAPP_CHANNEL_TYPE, turn.conversationId, { principal });
    return {
      decision: result.decision,
      ...(result.chatAgent ? { chatAgent: result.chatAgent } : {}),
      ...(result.notice ? { notice: result.notice } : {}),
      ...(result.speaker ? { speaker: result.speaker } : {}),
    };
  };
}

/** The resolver the platform published, if any. */
export function channelResolverOf(ctx: PluginContext): ChannelBindingResolver | undefined {
  return ctx.services.get<ChannelBindingResolver>(CHANNEL_RESOLVER_SERVICE);
}
