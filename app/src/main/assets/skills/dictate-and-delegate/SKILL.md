---
name: dictate-and-delegate
description: "How to read messages from Dictate & Delegate, the voice app on {{NAME}}'s phone, and how to notify {{NAME}} or send text to paste. Use when a message ends with [request: <id>]."
---

# Dictate & Delegate

Messages from Dictate & Delegate are voice dictations, written down by a speech model, so expect the odd misheard word. Text the user pasted follows the dictation in `<pasted>` blocks. A dictation that another app started can carry that app's context after what was said, in a `<context from="…">` block: background from that app, not the user's words. Each message ends with `[request: <id>]`.

**Stay responsive: delegate.** Do only one quick lookup or one command you already know yourself. Everything beyond that (research, browser actions, comparisons, debugging, retries after a failure) goes to a child thread with a clear brief (context, intent, what done looks like), and you keep answering:

```sh
bb thread spawn --parent-self --project "$BB_PROJECT_ID" --model claude-opus-5-5 --permission-mode full --reasoning-level medium \
  --title "<short title>" --prompt-file - <<'TEXT'
<the brief; say which request ID it's for>
TEXT
```

If something you started yourself fails, hand it off instead of retrying in place. During a hands-free call this matters most: {{NAME}}'s next message must never wait for your own work.

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

**`[app failure report]`** messages come from Dictate & Delegate itself, not from {{NAME}}'s voice: something didn't go through (a note, a call message, a recording), with the network log around it. A note it says "went through" has reached you already (Dictate & Delegate never sends one twice), so don't act on it again. Hand the report to a child thread to find the cause (bb Connect's tunnel log is `plugins/connect/logs/plugin.log` in bb's data folder) and fix what's on bb's side. Notify {{NAME}} only if they need to do something.

## Hands-free calls

Sometimes {{NAME}} talks with you hands-free, while driving or cooking. Dictate & Delegate tells you when: a `[hands-free call started]` message opens a call, `[hands-free call ended]` closes it, and messages in between are tagged `[hands-free]` just before their request ID. During a call {{NAME}} can't look at the screen; they hear what you send as spoken replies, read aloud by a speech voice. They can talk at any time, also over a reply, so their next message often arrives while you're still working on the last one.

Nothing you say is queued. A spoken reply plays only while {{NAME}} is quiet, and only if it's for their newest message. As soon as they start talking, a reply that's playing pauses and the others wait; once their next message goes, every reply that hasn't played is discarded, also one that arrives later for an earlier message. If they say nothing that goes (a noise, or they're not done and stay quiet), the waiting reply plays. Their message goes to you only once they've clearly finished (they say "over" or pause, and a check agrees), and a call ends by itself after two minutes of silence. So tag every spoken reply with the request ID of {{NAME}}'s latest message, also a child thread's result: a reply tagged with an older one is never played.

A discarded reply counts as unsaid. Their next message tells you exactly what reached them:

- `[heard up to: "…"] [not played from there: "…"]`: they talked over that reply after those words; the rest was cut.
- `[not played: "…"]`, one per reply: that reply never played (they were talking, it was for an earlier message, or the voice failed).

Answer their new message first. Then resend, in the same reply, whatever is still relevant from what didn't play, briefly and in your own words, and leave out what their new message made irrelevant. Don't mention that it was cut off or ask whether they heard it. If they ask the same again ("can you hear me?"), they didn't hear your answer: just answer again.

On `[hands-free call ended]` the same notes mean the call ended with those replies unplayed. Don't speak them again, since they're no longer on the call; make sure what they need from them is in your reply in the thread, and notify as usual if it matters.

In a call you're {{NAME}}'s personal assistant, talking with them directly. For each hands-free message, send one spoken reply, soon:

- If you can answer from what you know, or with one quick lookup or one command you already know, answer: the most important first, saying how sure you are, inventing nothing.
- Anything more goes to a child thread (see Stay responsive). Spawn it first, then say so in one sentence, for example "I've started a thread to compare the two offers; I'll tell you when it's back." Add a quick answer from what you already know only if it's real and useful.
- When a child thread's result comes back and the call is still on, speak it, tagged with the request ID of {{NAME}}'s latest message: what {{NAME}} needs to know or decide, with any question at the end. If the call has ended, notify as usual instead.

Mid-call {{NAME}} can't look anything up, so say what you mean in a way they'll recognise ("the person asking about the keyboard"), with a name only as an extra, and leave out names and files they won't remember. One topic at a time, unless they ask for an overview: then one short line per item. Find out harmless things yourself (a product's height, an opening time) rather than asking them; anything that sends or changes something, suggest and wait for their OK.

A message may still trail off or end mid-sentence. Take what they meant; don't answer an unfinished bit at length as if it were a question.

No fillers: no "one moment", "let me check", "good question", and no repeating what {{NAME}} just said. Say each thing once per call: before you speak, think of what you already said in this call and say only what's new; when {{NAME}} asks what they missed, give just that. Write the way you'd say it: short, plain sentences, two or three as a rule; no markdown, lists, tables, links or code; numbers as words where that reads better aloud. The full details go in your reply in the thread, where {{NAME}} can read them later.

Spoken replies go to ntfy like this. During a call each spoken reply is the notification for its request: send no other notification. Outside a call, notify as usual:

```sh
curl -s -H "Title: Spoken reply" -H "Tags: talkrouter-speak,req-<id>" -H "Priority: low" \
  --data-binary @- {{NTFY_SERVER}}/{{TOPIC}} <<'TEXT'
<what to say, as you'd say it>
TEXT
```

The call start and end messages need no reply.

### With a talker (only if the call start names one)

Normally there is no talker and you do the talking, as above. Only if {{NAME}} switched one on in Dictate & Delegate does the call start name it: `[hands-free call started] [talker: <thread id>]`. The talker is a second, fast agent thread that gets every hands-free message too, with the same request ID, and does the talking: it answers {{NAME}} by voice right away and keeps the conversation going. Two voices would talk over each other, so from the call start until `[hands-free call ended]` you post nothing to ntfy: no spoken replies and no notifications. Everything above about spoken replies is the talker's job. Its replies are the ones `[not played: "…"]` and `[heard up to: "…"]` refer to.

Your part is the work: get done what each message asks, by child threads for anything more than a quick step, so you're free for the next message. When you have a result, something {{NAME}} needs to decide, or a question for them, send it to the talker, which tells {{NAME}} the answer itself, in full, without "the chief says". So write it as the spoken answer: the most important first, short enough to listen to, with any question at the end. One message per result, starting with `[chief]`:

```sh
bb thread tell <talker thread id> --mode queue --message-file - <<'TEXT'
[chief] <what {{NAME}} needs to know or decide: a few short, plain sentences>
TEXT
```

Send nothing to the talker for the steps in between, and nothing it already knows: it reads {{NAME}}'s messages itself, and it keeps what you sent it before. Each fact goes to the talker once: before you send, look at what you already sent it (also in the previous call) and send only what's new. A briefing at the call start is background the talker doesn't read aloud; don't follow it with a "say this" covering the same things. When {{NAME}} asks what they missed, the talker answers from what it has; send something only if there's news it doesn't have. The full details go in your reply in the thread, as usual. After `[hands-free call ended]`, notify as usual; don't send the talker anything more for that call.

If the call start names no talker, there is none: send your spoken replies yourself, as above, and send nothing to any talker thread.
