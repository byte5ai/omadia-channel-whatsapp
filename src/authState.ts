import {
  initAuthCreds,
  BufferJSON,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
  type SignalKeyStore,
} from '@whiskeysockets/baileys';

import type { MemoryAccessor } from '@omadia/plugin-api';

/**
 * A persistent Baileys `AuthenticationState` backed by the plugin's
 * `ctx.memory` accessor — the structural equivalent of Baileys'
 * `useMultiFileAuthState`, but writing to the host's per-plugin memory store
 * instead of the local filesystem. This is what makes the linked WhatsApp
 * device survive restarts and redeploys: the signal creds + keys are written
 * under `/memories/agents/@omadia/channel-whatsapp/wa/…` and reloaded on the
 * next `activate()`.
 *
 * Reference shape: github.com/WhiskeySockets/Baileys `useMultiFileAuthState`.
 */
const AUTH_PREFIX = 'wa/';

/** Mirror Baileys' `fixFileName` so signal ids with `/` or `:` map to a safe
 *  relative memory path. */
function authPath(file: string): string {
  return AUTH_PREFIX + file.replace(/\//g, '__').replace(/:/g, '-');
}

export interface MemoryAuthState {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  /** Wipe all persisted auth — forces a fresh QR scan on the next connect. */
  clearAll: () => Promise<void>;
}

export async function useMemoryAuthState(memory: MemoryAccessor): Promise<MemoryAuthState> {
  const writeData = async (data: unknown, file: string): Promise<void> => {
    await memory.writeFile(authPath(file), JSON.stringify(data, BufferJSON.replacer));
  };

  const readData = async (file: string): Promise<unknown> => {
    const path = authPath(file);
    if (!(await memory.exists(path))) return null;
    try {
      return JSON.parse(await memory.readFile(path), BufferJSON.reviver);
    } catch {
      return null;
    }
  };

  const removeData = async (file: string): Promise<void> => {
    const path = authPath(file);
    if (await memory.exists(path)) await memory.delete(path);
  };

  const creds = ((await readData('creds.json')) as AuthenticationCreds | null) ?? initAuthCreds();

  const keys: SignalKeyStore = {
    get: async (type, ids) => {
      const data: { [id: string]: SignalDataTypeMap[typeof type] } = {};
      await Promise.all(
        ids.map(async (id) => {
          let value = await readData(`${type}-${id}.json`);
          if (type === 'app-state-sync-key' && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value as Record<string, unknown>);
          }
          if (value != null) {
            data[id] = value as SignalDataTypeMap[typeof type];
          }
        }),
      );
      return data;
    },
    set: async (data: SignalDataSet) => {
      const tasks: Array<Promise<void>> = [];
      for (const category of Object.keys(data) as Array<keyof SignalDataSet>) {
        const ids = data[category];
        if (!ids) continue;
        for (const id of Object.keys(ids)) {
          const value = ids[id];
          const file = `${category}-${id}.json`;
          tasks.push(value ? writeData(value, file) : removeData(file));
        }
      }
      await Promise.all(tasks);
    },
  };

  return {
    state: { creds, keys },
    saveCreds: () => writeData(creds, 'creds.json'),
    clearAll: async () => {
      if (await memory.exists('wa')) await memory.delete('wa');
    },
  };
}
