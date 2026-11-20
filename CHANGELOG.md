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
- **`/agent <Name>`, `/agent` (clears the selection) and `/agents` (lists)** are
  passed on verbatim as ordinary messages to the ChatAgent the channel resolver
  returned; it carries them out and replies with a `system` notice. The plugin
  parses nothing and calls no selection service. In groups a command counts as
  addressed even without a mention (`/agents` included, which the first 0.2.0
  draft missed).
- **Routing by the platform's decision.** Each turn asks the `channelResolver`
  for `(whatsapp, <chat jid>)` with the sender's principal. `bound`: the agent
  answers. `reject`: nobody answers; the resolver's ChatAgent still receives the
  text (it handles `/agent`) but whatever it returns is posted as `system`, an
  agent answer to a rejected turn is replaced by the notice, and without any
  agent the notice itself is posted as `system`. There is no fallback agent and
  a resolver error is a loud `system` failure text, not a silent default agent.
  Without a published resolver (minimal deployment) the single orchestrator
  answers, as before.
- **One principal form.** The sender is `user:whatsapp-phone:<jid>`, built with
  the SDK's `channelUserPrincipal` / `turnPrincipal` (replaces the hand-made
  `user:whatsapp:<jid>`). LID decision: the id is the phone-number JID whenever
  WhatsApp reveals it (`senderPn` / `participantPn`), so a direct chat and any
  LID group are one person; if only the LID is visible, the LID JID is the id
  (no number is guessed). `userRef.id` (memory keys, roster) is unchanged.
- **Polls and question cards as plain text (criterion 30).** A targeted-send and
  a conversation-send provider are registered (feature-detected). Polls and
  one-question cards go out as numbered text (`renderCardAsText`); the typed
  reply (`2`, `1,3`, `ja`, a date, ...) is read with `parseCardReply` and
  emitted to the kernel as the same typed `card_answer` a card click produces.
  In a group, reply to the question message (or @mention the bot); a free-text
  question takes only a reply to it. Open questions live in memory (a restart
  turns a late answer into an ordinary message). Providers send as `system`,
  decline `asChannelKey` (one number cannot be another agent's identity),
  honour `ignore_groups` and the allowlist, and return unreachability instead
  of throwing.
- **`compat.core` is `>=1.74.0 <2.0`** (placeholder; the final range is set with
  the release).
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
  is an ordinary message. The acknowledgement goes out under the routed agent's
  own speaker (known up front from the resolver's `speaker`), in the words of
  the pace template; only without a resolver speaker it is `system`. The
  on-demand answer details are not put into the message text.
- **Per-agent identity is not supported** (one number per installation); see the
  README for what it would take. Agents are selected with `/agent`; `/agents` lists them.
- Tests: `npm test` (`node:test` + esbuild, no new dependencies) covers speaker
  attribution on every emitter path, plain-text rendering, the decoration
  registry and group addressing/roster.

## 0.1.9

- Declare the capabilities this channel resolves through `ctx.services.get`
  (omadia#838), retiring the `@omadia/channel-whatsapp` row in
  `STANDALONE_LEGACY_SERVICE_GRANTS_2026_08_20`. `chatAgent@^1` under
  `requires:` (provided by `@omadia/orchestrator`); `channelResolver@1`
  under `optional_requires:` (kernel-published, absence survivable).
