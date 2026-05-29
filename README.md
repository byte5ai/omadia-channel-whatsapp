# @omadia/channel-whatsapp

A **WhatsApp channel** for the [Omadia](https://omadia.ai) harness. It links a
WhatsApp account to your Omadia orchestrator as a **WhatsApp Web "linked
device"** — you scan a QR code once (exactly like WhatsApp Web, and like the
OpenClaw WhatsApp integration this is modeled on) and from then on every chat
to that number is routed through your agents.

Built on [Baileys](https://github.com/WhiskeySockets/Baileys) (the
multi-device WhatsApp Web library). No phone-number registration, no Meta
Business API, no webhook host — just a QR scan.

> **Separate public repo.** This package lives in its own repository
> (`byte5ai/omadia-channel-whatsapp`) and is developed as a folder nested
> inside the Omadia core checkout — exactly like `marketing-site/` and `hub/`,
> and gitignored there for the same reason. Unlike those two it is **public
> OSS** (MIT).

---

## How it works

| Concern | Implementation |
|---|---|
| Transport | Long-lived WebSocket to WhatsApp Web via Baileys (`channel.transport.kind: websocket`). No inbound webhook. |
| Auth | QR **linked-device** scan. Persisted across restarts in `ctx.memory` (`src/authState.ts`). |
| Pairing UI | The QR is surfaced through the standard admin-UI iframe (`admin_ui_path`) — `assets/admin-ui/index.html` polls a status endpoint and renders the QR as a data-URL. |
| Inbound | `messages.upsert` → `IncomingTurn` → `core.handleTurnStream(turn)` (`src/inbound.ts`). |
| Outbound | The orchestrator's `SemanticAnswer` is rendered to a WhatsApp text message; rich elements degrade gracefully (`src/renderer.ts`). |
| Lifecycle | `export async function activate(ctx, core): Promise<ChannelHandle>` — the kernel's dynamic channel resolver picks up the bare `activate` export. |

Source map:

```
src/
├── plugin.ts             # activate(ctx, core) — wires everything together
├── whatsappConnection.ts # Baileys socket lifecycle: connect → QR → reconnect → send
├── authState.ts          # persistent Baileys auth-state over ctx.memory
├── inbound.ts            # native message → IncomingTurn, stream folding
├── renderer.ts           # SemanticAnswer → WhatsApp text (graceful degradation)
├── adminRouter.ts        # /api/whatsapp-channel/admin — QR status + re-pair
├── logger.ts             # Baileys (pino-shaped) logger → CoreApi.log
└── state.ts              # shared connection/QR state
assets/admin-ui/index.html # QR pairing page (harness-styled, single file)
```

---

## Build & install

Requires Node ≥ 20 (this repo pins the version in `.nvmrc`).

```bash
nvm use
npm install
npm run typecheck   # tsc gate (see "Typecheck" below)
npm run build       # esbuild-bundles Baileys into dist/plugin.js, then zips
# → out/omadia-channel-whatsapp-0.1.0.zip
```

Install the resulting ZIP into Omadia:

- **Local / smoke:** Admin-UI → *Store → Lokal → Upload* → drop the `.zip`.
- **Hub:** publish to the registry, then *Store → Hub → Jetzt installieren*
  (see the core's `docs/creating-plugins.md`).

After install, open the plugin's admin UI (Store detail page → Admin iframe, or
directly `…/api/whatsapp-channel/admin/index.html`), then on your phone:
**WhatsApp → Settings → Linked Devices → Link a Device** and scan the QR.

### Setup fields

| Field | Default | Purpose |
|---|---|---|
| `device_name` | `Omadia` | Label shown under WhatsApp → Linked Devices. |
| `ignore_groups` | `true` | Only respond in 1:1 chats; stay silent in groups. |
| `allowlist` | _(empty)_ | Comma-separated E.164 numbers allowed to chat (empty = all direct chats). |

---

## Why Baileys is bundled

A plugin's compiled code can only `import` packages that already exist in the
**host's** `node_modules` (the host resolves a plugin's bare specifiers against
its own tree). `@omadia/*` and `express` are host-provided, so they stay
`peerDependencies` and are marked **external**. Baileys + `qrcode` are *not*
host-provided, so `scripts/build-zip.mjs` **esbuild-bundles them into
`dist/plugin.js`**. (tsc alone can't do this — hence esbuild.)

> **Alternative:** if you would rather keep `dist` thin, move `@whiskeysockets/baileys`
> + `qrcode` to the host's `node_modules` (`npm i` them in the middleware) and
> drop them from the esbuild `external`-inverse — then a tsc-only build works.
> The bundled approach is the default because it keeps the plugin self-contained
> and installable through the Hub with zero host changes.

### Typecheck

`tsconfig.json` maps `@omadia/channel-sdk` / `@omadia/plugin-api` to the built
`.d.ts` in the **adjacent Omadia core checkout** (`../middleware/packages/…`),
which is where this folder lives during development. A standalone clone without
the core alongside won't typecheck (the types aren't published to npm), but the
esbuild build still works because those packages are `external` at runtime.

---

## Behaviour

- **ACK reaction.** Every accepted message gets an immediate 👀 reaction
  (OpenClaw-style) so the sender sees it was picked up before the answer lands.
- **Who it answers.** Messages from *other* people to the linked account
  (`fromMe:false`) and the operator's own **self-chat** ("Message Yourself").
  It deliberately ignores the account's messages in *other* chats and its own
  replies (id-tracked) — so no reply-loops and no answering your private chats.
- **Recommended setup:** link a **dedicated** WhatsApp account/number for the
  bot. Linking a personal account works for self-chat testing but the bot then
  shares your identity; use `allowlist` to scope which conversations are active.

## Limitations & caveats

- **Text only.** Inbound media and outbound images/files are surfaced as links,
  not media messages. Choice-cards / follow-ups degrade to text prompts.
- **One account per install.** A single linked device per plugin instance.
- **Unofficial API.** Baileys is an unofficial WhatsApp Web client. Use a number
  you control and accept that WhatsApp's Terms may restrict automated use — this
  is the same trade-off OpenClaw and every Baileys-based bot makes.
- **QR is sensitive.** Anyone who can load the admin UI can scan the pairing QR
  and link the bot to *their* WhatsApp. The admin route is only reachable
  through the operator-authenticated web-ui after install; keep it that way.

## License

MIT © byte5 GmbH
