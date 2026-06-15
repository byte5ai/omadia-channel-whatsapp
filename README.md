# @omadia/channel-whatsapp

Connects WhatsApp to omadia, so people can talk to their agents from WhatsApp. It routes chats into the omadia orchestrator and returns the reply in the same chat.

omadia is a self-hostable agentic OS: you build, run, and audit multi-agent AI teams from signed plugins. Main repo: [byte5ai/omadia](https://github.com/byte5ai/omadia). A channel is how a messaging platform reaches those agents.

## What it does

- Bridges WhatsApp to the omadia orchestrator over WhatsApp Web (Baileys).
- Pairs as a linked device via QR code, so no WhatsApp Business API account is required.
- Routes one-to-one chats, with an option to ignore groups and an optional number allowlist.

## How it works in omadia

This is a channel plugin (`kind: channel`). The omadia kernel activates it from `manifest.yaml`; the plugin opens a WhatsApp Web session, forwards each inbound chat to the orchestrator's chat agent, and sends the agent's response back. It needs an LLM provider assigned to the orchestrator first, otherwise there is no agent to answer.

## Install

Install from the omadia hub at [hub.omadia.ai](https://hub.omadia.ai) (omadia admin, plugins, install), or upload the built ZIP directly. On first start, scan the QR code with WhatsApp on your phone (Linked Devices) to pair.

## Configuration

| Setup field | Notes |
|-------------|-------|
| Device name | Shown in WhatsApp under Linked Devices. |
| Ignore groups | Skip group chats. |
| Allowed numbers | Optional allowlist. |

## Build from source

```bash
npm install
npm run build   # tsc, emits dist/
```

The plugin compiles against the omadia workspace packages it declares as peer deps. Link them from a local omadia checkout before building. See [byte5ai/omadia](https://github.com/byte5ai/omadia).

## License

MIT, byte5 GmbH
