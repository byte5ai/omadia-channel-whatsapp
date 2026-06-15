<div align="center">

# @omadia/plugin-channel-whatsapp

### Talk to your omadia agents from WhatsApp.

A signed omadia plugin that connects WhatsApp to your agent team over WhatsApp Web. It pairs as a linked device via QR code, so no WhatsApp Business API account is required.

[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE)
[![Built for omadia](https://img.shields.io/badge/built%20for-omadia-2496ED.svg)](https://github.com/byte5ai/omadia)
[![TypeScript](https://img.shields.io/badge/built%20with-TypeScript-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

[**Main repo**](https://github.com/byte5ai/omadia) · [**Website**](https://omadia.ai) · [**Plugin hub**](https://hub.omadia.ai) · [**What it does**](#what-it-does) · [**Install**](#install)

🇩🇪 Diese Anleitung gibt es auch [auf Deutsch](./README.de.md).

</div>

---

omadia is a self-hostable agentic OS: compose multi-agent teams from signed plugins, run them on your own machine, and get an auditable trail for every action. This plugin lets you reach those agents from WhatsApp. Main repo: [byte5ai/omadia](https://github.com/byte5ai/omadia).

## What it does

Connects WhatsApp to omadia over WhatsApp Web (Baileys). It pairs as a linked device via QR code, so no WhatsApp Business API account is required. One-to-one chats are routed into the omadia orchestrator, and the reply comes back in the same chat. You can ignore groups and limit access with a number allowlist.

## How it works in omadia

A channel plugin (`kind: channel`). The omadia kernel activates it from `manifest.yaml`. The plugin opens a WhatsApp Web session, forwards each inbound chat to the orchestrator chat agent, and sends the response back. It needs an LLM provider assigned to the orchestrator first.

## Install

1. Install from the [plugin hub](https://hub.omadia.ai) in the omadia admin UI (Store, Upload), or drop the built ZIP in directly.
2. There is no API key. Fill the setup fields below, then start the plugin.
3. On first start, scan the QR code with WhatsApp on the phone (Linked Devices) to pair.

Assign an LLM provider to the orchestrator first, otherwise the chat agent has no model to reply with.

## Configuration

| Setup field | Notes |
| --- | --- |
| Device name | Shown under Linked Devices. |
| Ignore groups | Skip group chats. |
| Allowed numbers | Optional allowlist. |

## Build from source

```bash
npm install
npm run build   # tsc, emits dist/
npm test        # validates manifest.yaml against core's invariants
```

`@omadia/plugin-api` is provided by the omadia host at runtime (optional peer dep). Link it from a local omadia checkout to build. See [byte5ai/omadia](https://github.com/byte5ai/omadia) for the layout.

## License

[MIT](LICENSE), byte5 GmbH