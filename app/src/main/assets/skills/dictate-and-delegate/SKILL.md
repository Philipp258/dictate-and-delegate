---
name: dictate-and-delegate
description: "How to read messages from Dictate & Delegate, the voice app on {{NAME}}'s phone, and how to notify {{NAME}} or send text to paste. Use when a message ends with [request: <id>]."
---

# Dictate & Delegate

Messages from Dictate & Delegate are voice dictations, written down by a speech model, so expect the odd misheard word. Text the user pasted follows the dictation in `<pasted>` blocks. Each message ends with `[request: <id>]`.

**When a request is done, or when you need {{NAME}},** send one notification, then end your turn. Send none for the steps in between:

```sh
curl -s -H "Title: <short title>" -H "Click: {{LINK_BASE}}/threads/$BB_THREAD_ID" \
  --data-binary @- {{NTFY_SERVER}}/{{TOPIC}} <<'TEXT'
<one or two sentences: what's done, or what you need>
TEXT
```

**Text to paste** (a message, an email, a reply, a command): as soon as it's ready, send just that text. Dictate & Delegate shows it with an Insert button:

```sh
curl -s -H "Title: Text to paste" -H "Tags: talkrouter-paste,req-<id>" \
  -H "Actions: broadcast, Copy, intent=app.driftdictation.COPY_CHIEF_TEXT, extras.request=<id>, clear=true" \
  --data-binary @- {{NTFY_SERVER}}/{{TOPIC}} <<'TEXT'
<only the text to paste>
TEXT
```

## Hands-free calls

Sometimes {{NAME}} talks with you hands-free, while driving or cooking. Dictate & Delegate tells you when: a `[hands-free call started]` message opens a call, `[hands-free call ended]` closes it, and messages in between are tagged `[hands-free]` just before their request ID. During a call {{NAME}} can't look at the screen; they hear what you send as spoken replies, read aloud by a speech voice. They can talk at any time, also over a reply, so their next message often arrives while you're still working on the last one.

Your spoken replies may arrive late. A reply never plays while it's {{NAME}}'s turn: while they talk, while they have words not sent yet, and while their message is being sent. It plays once their message went, or once they've said nothing for a while. So a new message from them may have been written before they heard your last reply: answer it with that reply in mind, don't repeat the reply, and if the new message changes the task, follow the new direction. A reply they talk over stops at once and the rest of it is dropped: it is not played again. Their next message then carries `[heard up to: "…"]` with the last words they heard.

The app tells you only what didn't reach them:

- `[didn't hear your reply: "…"]` on a message (or `[didn't hear 3 replies: "…" and 2 more]`): that reply couldn't be played (the voice failed), or, in a call with a talker, it was dropped because {{NAME}} had already sent a newer message. Carry over what they still need from it, briefly and in your own words.
- `[heard up to: "…"]` on a message: they talked over that reply after those words, and the rest of it was dropped. Answer their new message first; repeat from the rest only what still matters, briefly and in your own words. If they hardly heard any of it, it shows as `[didn't hear your reply: "…"]`.
- `[didn't hear your reply: "…"]` or `[heard up to: "…"]` on `[hands-free call ended]`: the call ended with that reply still waiting, cut off after those words, or talked over with no message after it. They didn't hear it, or the rest of it. Don't speak it again, since they're no longer on the call; make sure what they need from it is in your reply in the thread, and notify as usual if it matters.

For each hands-free message, send a first spoken answer soon, from what you already know: a real answer, not a filler like "one moment", saying how sure you are and inventing nothing. Then do whatever research or work the request needs, and send a final spoken answer with what {{NAME}} needs to know or decide; if you need something from them, end with the question. Write both the way you'd say them: short, plain sentences, no markdown, lists, tables, links or code, numbers as words where that reads better aloud. The full details go in your reply in the thread, where {{NAME}} can read them later.

Spoken replies go to ntfy like this, and during a call they replace the usual notification; outside a call, notify as usual:

```sh
curl -s -H "Title: Spoken reply" -H "Tags: talkrouter-speak,req-<id>" -H "Priority: low" \
  --data-binary @- {{NTFY_SERVER}}/{{TOPIC}} <<'TEXT'
<what to say, as you'd say it>
TEXT
```

The call start and end messages need no reply.

### With a talker

The call start may name a talker: `[hands-free call started] [talker: <thread id>]`. The talker is a second, fast agent thread that gets every hands-free message too, with the same request ID, and does the talking: it answers {{NAME}} by voice right away and keeps the conversation going. Two voices would talk over each other, so from the call start until `[hands-free call ended]` you post nothing to ntfy: no spoken replies and no notifications. Everything above about spoken replies is the talker's job. Its replies are the ones `[didn't hear your reply: "…"]` and `[heard up to: "…"]` refer to.

Your part is the work. Do what each message asks, and when you have a result, something {{NAME}} needs to decide, or a question for them, send it to the talker, which tells {{NAME}} the answer itself, in full, without "the chief says". So write it as the spoken answer: the most important first, short enough to listen to, with any question at the end. One message per result, starting with `[chief]`:

```sh
bb thread tell <talker thread id> --mode queue --message-file - <<'TEXT'
[chief] <what {{NAME}} needs to know or decide: a few short, plain sentences>
TEXT
```

Send nothing to the talker for the steps in between, and nothing it already knows: it reads {{NAME}}'s messages itself. The full details go in your reply in the thread, as usual. After `[hands-free call ended]`, notify as usual; don't send the talker anything more for that call.

If the call start names no talker, there is none: send your spoken replies yourself, as above.
