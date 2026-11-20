# Changelog

## 0.2.0

Agents as colleagues (omadia epic byte5ai/omadia#2042, issue #4). Needs a kernel
with the speaker/decoration/roster contracts (omadia#2045, #2086, #2087); do not
publish before that kernel is live.

- **One outbound path, every message attributed.** All output goes through one
  emitter on the SDK plain-text renderer (`renderPlainAnswer`). Every message
  carries a speaker (agent or `system`); an answer without one is never sent
  and the user gets a system error text instead. Plugin-originated texts speak
  as `system`.
- **Speaker only where unclear (INV-4).** One identity per installation, so a
  plain name line (`Mira: ...`) appears only when several agents speak in a
  conversation or on the first answer after a change. The history is kept in the
  plugin-wide memory tree and survives restarts.
- **Consultations** render as plain attribution (`Jonas: ...`); a `system`
  notice (for example the confirmation of `/agent Mira`) is its own text.
- **Decorations.** Removed the eyes receipt reaction, the follow-up list, the
  disclaimer line and the emoji on choice cards/attachments. Choice cards are
  numbered text. The only declared decoration is the AI disclosure line
  (`ai_disclosure_line`, part of the answer text per `ai_disclosure_frequency`);
  the typing indicator stays as the pace signal.
- **`/agent` and `/agent <Name>`** are passed to the kernel verbatim as ordinary
  messages (the management layer parses them and replies with a `system`
  notice). In groups the command counts as addressed even without a mention.
- **Groups (`ignore_groups` off).** The bot answers only when @mentioned,
  replied to, or given `/agent`; its own mention token is stripped from the
  text. It answers only while WhatsApp lists the group members; otherwise one
  system notice per group per 10 minutes. A roster provider
  (`registerRosterProvider`, feature-detected) reports `complete`, `partial` or
  `unknown` from Baileys `groupMetadata`, cached 30 s and dropped on
  membership changes.
- **Turn context.** Turns now carry `channelType`, `channelKey`,
  `conversationType` (`group`/`direct`) and a `TurnOrigin` (conversation id,
  speaker, message id) so the kernel can tell groups from direct chats.
- **Pace.** The agent call runs through the SDK's `runPacedTurn`: the typing
  indicator ("composing") from the start and renewed every 8 s, exactly one
  acknowledgement ("Ich kümmere mich darum, das dauert einen Moment.") after 8 s
  of work, no progress messages. WhatsApp has no reply window, so a late answer
  is an ordinary message. The acknowledgement is a `system` text (the plugin
  cannot name the routed agent before its answer). The on-demand answer details
  are not put into the message text.
- **Per-agent identity is not supported** (one number per installation); see the
  README for what it would take. Agents are selected with `/agent`.
- Tests: `npm test` (`node:test` + esbuild, no new dependencies) covers speaker
  attribution on every emitter path, plain-text rendering, the decoration
  registry and group addressing/roster.

## 0.1.9

- Declare the capabilities this channel resolves through `ctx.services.get`
  (omadia#838), retiring the `@omadia/channel-whatsapp` row in
  `STANDALONE_LEGACY_SERVICE_GRANTS_2026_08_20`. `chatAgent@^1` under
  `requires:` (provided by `@omadia/orchestrator`); `channelResolver@1`
  under `optional_requires:` (kernel-published, absence survivable).
