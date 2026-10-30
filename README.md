# Dictate & Delegate

**One intuitive shortcut to AI, from any app on your phone.**

Press a key and talk: dictation, text creation and independent agents, from one starting point.

### Dictate while you do anything

*Example: a friend sends a place, you talk while you look at it, and your words land in the chat.*

<table>
<tr>
<td width="25%" valign="top"><img src="docs/images/steps/talk-1.png" width="200" alt="A chat with Sam, who sends a link to a café"></td>
<td width="25%" valign="top"><img src="docs/images/steps/talk-2.png" width="200" alt="The café page, while you talk about it"></td>
<td width="25%" valign="top"><img src="docs/images/steps/talk-3.png" width="200" alt="The chat with your reply written into the message field"></td>
<td width="25%" valign="top"><img src="docs/images/steps/talk-4.png" width="200" alt="The chat with the reply sent and Sam answering"></td>
</tr>
<tr>
<td valign="top">① A friend sends you a place for Saturday.</td>
<td valign="top">② Start talking while you look at it.</td>
<td valign="top">③ Your words appear in the chat.</td>
<td valign="top">④ Send.</td>
</tr>
</table>

### Turn your words into any text

One fast step that follows your instructions, with templates if you like.

*Example: an apartment application, from your template and what you see on the listing.*

<table>
<tr>
<td width="25%" valign="top"><img src="docs/images/steps/refine-1.png" width="200" alt="An apartment application saved as a template"></td>
<td width="25%" valign="top"><img src="docs/images/steps/refine-2.png" width="200" alt="An apartment listing, while you talk about it"></td>
<td width="25%" valign="top"><img src="docs/images/steps/refine-3.png" width="200" alt="The finished application is ready"></td>
<td width="25%" valign="top"><img src="docs/images/steps/refine-4.png" width="200" alt="The contact form filled with the finished application"></td>
</tr>
<tr>
<td valign="top">① Save your application once as a template.</td>
<td valign="top">② Start talking while you look at the offer: <i>"Use my application template, mention that I have no pets and that I love the balcony."</i></td>
<td valign="top">③ It writes the application from your template.</td>
<td valign="top">④ It lands in the contact form, ready to send.</td>
</tr>
</table>

### Hand bigger tasks to an agent on its own machine

It works independently on your computer or a server, and reports back.

*Example: "Ada, build me a snake game." Then you give feedback while you play: no typing, no switching apps.*

<table>
<tr>
<td width="25%" valign="top"><img src="docs/images/steps/agent-1.png" width="200" alt="On the phone, you ask Ada, your agent, for a snake game"></td>
<td width="25%" valign="top"><img src="docs/images/steps/agent-2.png" width="200" alt="The computer, where Ada plans, writes and tests the game"></td>
<td width="25%" valign="top"><img src="docs/images/steps/agent-3.png" width="200" alt="A notification on the phone: your game is ready"></td>
<td width="25%" valign="top"><img src="docs/images/steps/agent-4.png" width="200" alt="Playing the game while asking Ada for changes"></td>
</tr>
<tr>
<td valign="top">① <i>"Ada, build me a little snake game."</i></td>
<td valign="top">② Ada builds it on your computer.</td>
<td valign="top">③ You get a message when it's ready.</td>
<td valign="top">④ Give feedback while you play: <i>"Ada, make it faster each level."</i> No typing, no switching apps.</td>
</tr>
</table>

▶ **Watch it play out:**

https://github.com/user-attachments/assets/1d1d507f-47d5-4513-99e1-ce83b8d83619

## How it works

<img src="docs/images/how-it-works.svg" width="100%" alt="Your phone sends audio to a speech-to-text model; the transcript always comes back to insert. Then Jev or you decide: one text-model call that comes back in seconds to insert, or an independent agent on its own machine (bb) that comes back minutes to hours later through a notification or text to insert.">

Your words always come back to you first, a few seconds after you stop talking. From there, Jev (a small decision model) or you decide whether the text goes on to a text model for a finished text, or to an independent agent on its own machine. Both come back to your phone.

### The floating panel

Press a shortcut in any app and talk. A small floating panel stays next to whatever you're doing, so you can keep browsing, reading or testing while you speak. When you're done, you can use the transcript anywhere.

<img src="docs/images/panel-still.png" width="240" alt="The floating panel recording over a web page, with a speech bubble of what you say">

### Refine: one model call, any instruction

**✨ Refine** sends what you said through a single call to a text model. It quickly processes or generates any text you need, based on:

- a default prompt (roughly "find the intention of the text and improve it towards it"),
- predefined text templates (like a sample job application),
- any instruction you dictate ("Write an application to startup X based on our template. Emphasize that…").

### Agents through bb

Dictate & Delegate sends your dictation to an agent running on its own machine, your laptop or a server, through [bb](https://getbb.app), with Claude Code or Codex on your existing subscription. Usually you'd have a kind of "coordinator" or "chief of staff" agent there that routes and manages all larger independent work. This can include coding, research, recurring tasks and a lot of other things.

### Models and cost

The latest speech models: MAI-Transcribe 2 by default, 60 languages, and you can switch languages mid-sentence. You pay per use at the providers' prices, about $0.10 per hour of audio, so half an hour of talking a day comes to about $1.50 a month. There's no subscription, and every note shows what it cost.

### Open source

It's MIT licensed, so you can read exactly what it sends, or build it yourself. Your voice and text go only to the providers you choose; there's no Dictate & Delegate server.

## Why bb

bb runs Claude Code and Codex and adds nice extra features on top. It works with common subscriptions like Claude and ChatGPT, has full remote control, and gives Dictate & Delegate a nice interface to communicate with.

## Install

**You need:** an [OpenRouter](https://openrouter.ai) key and an Android phone with Android 14 or newer. For agents: [bb](https://getbb.app) with Claude Code or Codex, and the free [ntfy](https://ntfy.sh) app for notifications.

1. Download the APK of the newest Android release (tag `v…`) from [Releases](https://github.com/Philipp258/dictate-and-delegate/releases) and open it on your phone. After that the app updates itself: it shows **Update to …** on Home when there's a new version (Settings → About → Check for updates checks at once), and Android asks you to confirm the install.
2. Open Dictate & Delegate and paste your OpenRouter key. Setup walks you through the microphone, the start key and Insert.
3. Optional: in bb, run `bb plugin enable bb--mcp`, then sign in from Dictate & Delegate. It sets up your agent.

[More on how it works](docs/HOW-IT-WORKS.md) · [Using the app](docs/GUIDE.md) · [Build & test](docs/DEVELOPMENT.md)
