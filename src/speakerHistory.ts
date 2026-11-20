import type { SpeakerHistoryStore } from '@omadia/channel-sdk';
import type { MemoryAccessor } from '@omadia/plugin-api';

const HISTORY_FILE = 'speaker-history.json';
const MAX_CONVERSATIONS = 500;
const FLUSH_DELAY_MS = 2_000;

interface Entry {
  agentIds: Set<string>;
  lastAgentId?: string;
}

interface StoredEntry {
  agentIds: string[];
  lastAgentId?: string;
}

/**
 * Remembers which agents spoke in which WhatsApp conversation, so the plain
 * name line (INV-4) is decided the same way after a restart. `get`/`record`
 * stay synchronous (the SDK contract); persistence is a debounced
 * write-through to the plugin-wide memory tree. Persistence failures only
 * cost a later redundant or missing name line, never an answer.
 */
export class PersistentSpeakerHistoryStore implements SpeakerHistoryStore {
  private readonly byConversation = new Map<string, Entry>();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly memory: MemoryAccessor | undefined,
    private readonly onError: (message: string, error: unknown) => void = () => {},
  ) {}

  /** Load the persisted history. Call once at activation. */
  async load(): Promise<void> {
    if (!this.memory) return;
    try {
      if (!(await this.memory.exists(HISTORY_FILE))) return;
      const parsed = JSON.parse(await this.memory.readFile(HISTORY_FILE)) as Record<string, StoredEntry>;
      for (const [key, stored] of Object.entries(parsed)) {
        if (!Array.isArray(stored.agentIds)) continue;
        this.byConversation.set(key, {
          agentIds: new Set(stored.agentIds.filter((id) => typeof id === 'string')),
          ...(typeof stored.lastAgentId === 'string' ? { lastAgentId: stored.lastAgentId } : {}),
        });
      }
    } catch (err) {
      this.onError('could not load speaker history', err);
    }
  }

  get(conversationKey: string): { agentIds: ReadonlySet<string>; lastAgentId?: string } | undefined {
    return this.byConversation.get(conversationKey);
  }

  record(conversationKey: string, agentId: string): void {
    const previous = this.byConversation.get(conversationKey);
    const agentIds = new Set(previous?.agentIds ?? []);
    agentIds.add(agentId);
    // Re-insert so the Map keeps recency order for the bounded eviction below.
    this.byConversation.delete(conversationKey);
    this.byConversation.set(conversationKey, { agentIds, lastAgentId: agentId });
    this.evictOldest();
    this.scheduleFlush();
  }

  /** Write pending changes now (deactivate). */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (!this.memory) return;
    const out: Record<string, StoredEntry> = {};
    for (const [key, entry] of this.byConversation) {
      out[key] = {
        agentIds: [...entry.agentIds],
        ...(entry.lastAgentId !== undefined ? { lastAgentId: entry.lastAgentId } : {}),
      };
    }
    try {
      await this.memory.writeFile(HISTORY_FILE, JSON.stringify(out));
    } catch (err) {
      this.onError('could not persist speaker history', err);
    }
  }

  private evictOldest(): void {
    while (this.byConversation.size > MAX_CONVERSATIONS) {
      const oldest = this.byConversation.keys().next().value;
      if (oldest === undefined) return;
      this.byConversation.delete(oldest);
    }
  }

  private scheduleFlush(): void {
    if (!this.memory || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, FLUSH_DELAY_MS);
    this.flushTimer.unref?.();
  }
}
