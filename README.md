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

Connects WhatsApp to omadia over WhatsApp Web (Baileys). It pairs as a linked device via QR code, so no WhatsApp Business API account is required. One-to-one chats are routed into the omadia orchestrator, and the reply comes back in the same chat. You can ignore groups and limit access with a number allowlist. The chat reads like a conversation with a colleague: plain text, no status reactions, footers or buttons. Long work shows the typing indicator and, after about eight seconds, one short acknowledgement.

## How it works in omadia

A channel plugin (`kind: channel`). The omadia kernel activates it from `manifest.yaml`. The plugin opens a WhatsApp Web session, forwards each inbound chat to the orchestrator chat agent, and sends the response back. It needs an LLM provider assigned to the orchestrator first.

## Addressing an agent

**Per-agent identity is not supported.** One installation is one linked WhatsApp number (one Baileys session, one QR pairing), so every agent is reached through that one number. Giving each agent its own number would mean one session per agent: its own auth state, its own pairing, its own routing from number to agent. The plugin does not do that. For the operator it would also mean one number and one phone with WhatsApp per agent, and every additional unofficial linked device adds to the risk that WhatsApp restricts it.

Instead you choose the agent in the chat:

- `/agent` lists the agents available to you in this channel.
- `/agent Mira` selects Mira for you in this conversation. The omadia kernel stores the selection and confirms it once with a system message. Only agents the operator made available to you in WhatsApp can be selected.
- The plugin does not parse the command. WhatsApp has no native bot commands, so the text is passed to the kernel as an ordinary message.

Who is speaking: with one agent in a conversation there is no name line. Where several agents speak in one conversation, or on the first answer after the speaker changed, the answer starts with a plain name line (`Mira: ...`). A colleague's contribution to an answer appears as plain attribution (`Jonas: ...`), and messages from the system itself (for example "this agent is not available to you") are plain text without an agent name.

## Groups

Groups are ignored by default (**Ignore groups** on). With it off:

- The bot answers only when it is @mentioned, when someone replies to one of its messages, or when a message starts with `/agent`. It never answers every message.
- It answers only while WhatsApp lets it read the group's member list. Otherwise it says so once (at most every 10 minutes per group) and stays silent. The plugin reports the member list to the kernel (`complete`, `partial` or `unknown`), which uses it to decide what an answer in front of this audience may contain.
- WhatsApp may address members by a privacy ID (`@lid`) instead of a phone number. The roster then carries that ID, with the phone number as `externalId` when WhatsApp provides it.

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
npm run build   # bundles dist/plugin.js and the upload ZIP
npm test        # node:test suites (speaker, plain text, decorations, groups)
```

`@omadia/channel-sdk` and `@omadia/plugin-api` are provided by the omadia host at runtime. To typecheck and test, build them in a local omadia checkout and point the tests at it: `OMADIA_CHANNEL_SDK_DIST` and `OMADIA_PLUGIN_API_DIST` (defaults: `../middleware/packages/harness-channel-sdk/dist/index.js` and `../middleware/packages/plugin-api/dist/index.js`). See [byte5ai/omadia](https://github.com/byte5ai/omadia) for the layout.

## License

[MIT](LICENSE), byte5 GmbH