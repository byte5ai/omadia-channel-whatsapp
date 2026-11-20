import type { CardOption, QuestionCard, TargetedPoll } from '@omadia/channel-sdk';

/** A question that is not answered within this long stops taking typed answers (unless its card closes earlier). */
export const OPEN_CARD_TTL_MS = 48 * 60 * 60_000;
const MAX_OPEN_CARDS = 200;

const MIN_POLL_OPTIONS = 2;
const MAX_POLL_OPTIONS = 6;
const MAX_POLL_ID_LENGTH = 128;
/** The id of the one question a poll is turned into. */
export const POLL_QUESTION_ID = 'vote';

export type OpenCardKind = 'poll' | 'card';

/** A question posted as plain text that is still waiting for typed answers. */
export interface OpenCard {
  readonly kind: OpenCardKind;
  readonly conversationId: string;
  readonly card: QuestionCard;
  /** The WhatsApp id of the message that carries the question, when known. */
  readonly messageId?: string;
  readonly postedAt: number;
}

/** Why a poll cannot be posted; `undefined` when it can. */
export function pollProblem(poll: TargetedPoll): string | undefined {
  if (typeof poll.pollId !== 'string' || poll.pollId.length === 0 || poll.pollId.length > MAX_POLL_ID_LENGTH) {
    return `pollId must be 1..${String(MAX_POLL_ID_LENGTH)} characters`;
  }
  if (typeof poll.question !== 'string' || poll.question.trim().length === 0) return 'the poll question is empty';
  const options = poll.options;
  if (!Array.isArray(options) || options.length < MIN_POLL_OPTIONS || options.length > MAX_POLL_OPTIONS) {
    return `a poll needs ${String(MIN_POLL_OPTIONS)}..${String(MAX_POLL_OPTIONS)} options`;
  }
  const ids = new Set<string>();
  for (const option of options) {
    if (typeof option.id !== 'string' || option.id.length === 0 || option.id.length > MAX_POLL_ID_LENGTH) {
      return `every option needs an id of 1..${String(MAX_POLL_ID_LENGTH)} characters`;
    }
    if (typeof option.label !== 'string' || option.label.trim().length === 0) {
      return `option '${option.id}' has an empty label`;
    }
    if (ids.has(option.id)) return `option id '${option.id}' occurs twice`;
    ids.add(option.id);
  }
  return undefined;
}

/**
 * A poll is a card with one single-choice question, so the plain-text path
 * (`renderCardAsText` / `parseCardReply`) is the same for polls and cards.
 */
export function pollToCard(poll: TargetedPoll): QuestionCard {
  const options: CardOption[] = poll.options.map((o) => ({ id: o.id, label: o.label }));
  return {
    cardId: poll.pollId,
    title: poll.question,
    ...(poll.hint ? { intro: poll.hint } : {}),
    questions: [{ id: POLL_QUESTION_ID, kind: 'single_choice', label: 'Antworte mit der Nummer:', options }],
  };
}

function isExpired(open: OpenCard, now: number): boolean {
  const closes = open.card.closesAt === undefined ? Number.NaN : Date.parse(open.card.closesAt);
  if (!Number.isNaN(closes)) return now >= closes;
  return now - open.postedAt >= OPEN_CARD_TTL_MS;
}

/**
 * Questions posted as plain text and not yet answered, per conversation. In
 * memory: after a restart a late typed answer is an ordinary message to the
 * agent, never a lost or a misfiled answer.
 */
export class OpenCardRegistry {
  private readonly byConversation = new Map<string, OpenCard[]>();

  constructor(private readonly now: () => number = Date.now) {}

  open(entry: Omit<OpenCard, 'postedAt'>): void {
    const others = (this.byConversation.get(entry.conversationId) ?? []).filter(
      (o) => o.card.cardId !== entry.card.cardId,
    );
    this.byConversation.set(entry.conversationId, [...others, { ...entry, postedAt: this.now() }]);
    this.evict();
  }

  /**
   * The open question a typed message answers: the one it replies to, else the
   * most recent open one of the conversation.
   */
  find(conversationId: string, quotedMessageId?: string): OpenCard | undefined {
    const now = this.now();
    const live = (this.byConversation.get(conversationId) ?? []).filter((o) => !isExpired(o, now));
    if (live.length === 0) {
      this.byConversation.delete(conversationId);
      return undefined;
    }
    this.byConversation.set(conversationId, live);
    const quoted = quotedMessageId ? live.find((o) => o.messageId === quotedMessageId) : undefined;
    return quoted ?? live.at(-1);
  }

  close(conversationId: string, cardId: string): void {
    const rest = (this.byConversation.get(conversationId) ?? []).filter((o) => o.card.cardId !== cardId);
    if (rest.length === 0) this.byConversation.delete(conversationId);
    else this.byConversation.set(conversationId, rest);
  }

  private evict(): void {
    let total = 0;
    for (const list of this.byConversation.values()) total += list.length;
    while (total > MAX_OPEN_CARDS) {
      const oldest = this.byConversation.keys().next().value;
      if (oldest === undefined) return;
      total -= this.byConversation.get(oldest)?.length ?? 0;
      this.byConversation.delete(oldest);
    }
  }
}
