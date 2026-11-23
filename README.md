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

Connects WhatsApp to omadia over WhatsApp Web (Baileys). It pairs as a linked device via QR code, so no WhatsApp Business API account is required. One-to-one chats are routed to your agents, and the reply comes back in the same chat. You can ignore groups and limit access with a number allowlist. The chat reads like a conversation with a colleague: plain text, no status reactions, footers or buttons. Long work shows the typing indicator and, after about eight seconds, one short acknowledgement.

## How it works in omadia

A channel plugin (`kind: channel`). The omadia kernel activates it from `manifest.yaml`. The plugin opens a WhatsApp Web session, forwards each inbound chat to the agent runtime, and sends the response back. It needs an LLM provider assigned to the agent runtime first.

## Addressing an agent

**Per-agent identity is not supported.** One installation is one linked WhatsApp number (one Baileys session, one QR pairing), so every agent is reached through that one number. Giving each agent its own number would mean one session per agent: its own auth state, its own pairing, its own routing from number to agent. The plugin does not do that. For the operator it would also mean one number and one phone with WhatsApp per agent, and every additional unofficial linked device adds to the risk that WhatsApp restricts it.

Instead you choose the agent in the chat:

- `/agents` lists the agents available to you in this channel.
- `/agent Mira` selects Mira for you in this conversation. The omadia kernel stores the selection and confirms it once with a system message. Only agents the operator made available to you in WhatsApp can be selected.
- `/agent` on its own clears your selection; the binding or the default agent applies again.
- The plugin does not parse the commands. WhatsApp has no native bot commands, so the text is passed on as an ordinary message to the agent the platform resolved for the conversation, and that agent carries the command out.

**Where the selection lives:** `/agent` is stored per chat and person: the key is the group JID (a group) or your phone-number JID (a direct chat; the privacy ID only when WhatsApp reveals no number) together with your identity. In a group everyone has their own selection; the same person has separate selections in separate chats. A direct chat that WhatsApp addresses by phone number at one time and by privacy ID at another is therefore one selection. The same key is what a channel binding of a direct chat must name: bind direct chats by phone-number JID. Messages are still sent to the JID WhatsApp used. WhatsApp states no language for a person, so system messages are in German unless a language is known.

If no agent answers you here (the agent is switched off, was deleted, or is not available to you), you get a short system message saying so. There is no fallback agent that answers instead.

You are one person in every chat: your selection and the operator's availability rules are keyed by one identity, `user:whatsapp-phone:<number>@s.whatsapp.net`. WhatsApp increasingly shows a person only by a privacy ID (`@lid`); when it also reveals the phone number, the number is used, so a direct chat and any group share one identity. If WhatsApp shows only the privacy ID, that ID is the identity (and your selection does not carry over to a chat where your number is visible).

Who is speaking: with one agent in a conversation there is no name line. Where several agents speak in one conversation, or on the first answer after the speaker changed, the answer starts with a plain name line (`Mira: ...`). A colleague's contribution to an answer appears as plain attribution (`Jonas: ...`), and messages from the system itself (for example "this agent is not available to you") are plain text without an agent name.

## Polls and questions

An agent can ask you a poll or a question (for example in a facilitated discussion). WhatsApp has no native poll or card here, so the omadia kernel posts it as plain, numbered text in an ordinary message and keeps the question open. You answer by typing: the number of an option (`2`), several numbers (`1,3`), a ranking (`2,1,3`), `ja` / `nein`, a number or a date (`2026-12-01`). In a group, reply to the question message (or @mention the bot); in a direct chat a message that addresses the bot is enough when one question is open. The kernel reads the reply and turns it into the same structured answer a card click would be, and then the agent does not also reply to it (the plugin asks the kernel before it starts a turn, waiting at most 1.5 s); a message that does not answer stays an ordinary message. The plugin has no card code of its own: it reports the id of the message it sent and tells the kernel about every inbound message with the message it quotes (`replyToMessageId`) and whether it addresses the bot (`addressedToBot`). Where the kernel reads every message of a group for a facilitation, the plugin also reports unaddressed group messages and starts no turn of its own for addressed ones.

The plugin registers a targeted and a conversation send provider for this. They declare nothing special: messages go out as `system` text, and the plugin never sends as another agent's own identity (one number).

## Groups

Groups are ignored by default (**Ignore groups** on). With it off:

- The bot answers only when it is @mentioned, when someone replies to one of its messages, or when a message starts with `/agent` or `/agents`. It never answers every message.
- It answers only while WhatsApp lets it read the group's member list. Otherwise it says so once (at most every 10 minutes per group) and stays silent. The plugin reports the member list to the kernel (`complete`, `partial` or `unknown`), which uses it to decide what an answer in front of this audience may contain.
- WhatsApp may address members by a privacy ID (`@lid`) instead of a phone number. The roster then carries that ID, with the phone number as `externalId` when WhatsApp provides it.

## Install

1. Install from the [plugin hub](https://hub.omadia.ai) in the omadia admin UI (Store, Upload), or drop the built ZIP in directly.
2. There is no API key. Fill the setup fields below, then start the plugin.
3. On first start, scan the QR code with WhatsApp on the phone (Linked Devices) to pair.

Assign a model to the agent runtime first, otherwise the chat agent has no model to reply with.

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