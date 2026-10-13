# Messages and context

Give the agent a task in the composer. Add files, quote a previous response, or
include a skill when the task needs more context.

Messages can contain up to 120,000 characters. Longer drafts stay in the composer
so you can shorten them or split them into several messages.

Pasting 32 KiB or more of text adds that fragment as a text-file attachment so
the agent can inspect it without filling the model context. A smaller paste also
becomes an attachment when inserting it would exceed the message limit. On a
hardware keyboard, use `Cmd+Shift+V` on Apple devices or `Ctrl+Shift+V` elsewhere
to keep a large paste editable in the composer instead.

## Attach files

Attach up to 100 files per message. Each image can be up to 10 MiB, with at most
80 MiB of images in one message. Other files, including videos, can be up to
50 MiB each, subject to the environment's upload support and limit. The agent
receives them on the environment's machine. Provider and model limits still
apply, including images already in the conversation. A video attachment gives
the agent a file path; it does not enable native video input.

Uploads begin when you add an attachment. All uploads must finish before the
message can send. Retry or remove a failed upload. On web and desktop, reloading
before an upload finishes requires you to attach that file again.

You can drag or paste images into the web or desktop composer. HEIC and HEIF
photos are converted to JPEG there and when selected from the mobile photo
library; photos over the image limit are also resized to fit. On mobile, you can
also send files to CodeWrench through another app's system share sheet.

See [images and videos](#images-and-videos-in-messages) for previewing and saving media.

## Send while the agent is working

On web and desktop, choose **Settings → General → Follow-up behavior** to queue
new messages for a later turn or steer the running turn immediately. The setting
applies to this client; already queued messages keep their place. Queued messages
are saved on the server and can be edited, reordered, or removed above the composer.
`Cmd+Enter` on macOS or `Ctrl+Enter` on Windows and Linux uses the opposite action:
it steers when your default is Queue and queues when your default is Steer.

Use `Cmd+Shift+Enter` on macOS or `Ctrl+Shift+Enter` on Windows and Linux to send
the oldest queued message as a steer. This leaves the current draft intact and
requires an active turn that supports steering. Change
`thread.steerQueuedMessage` in **Settings → Keybindings** to use another shortcut.

Press `Option+Up` on macOS or `Alt+Up` on Windows and Linux with the cursor at the
start of the composer to edit the most recently queued message. Change
`thread.editQueuedMessage` to use another shortcut.

Mobile has the same choice under **Settings → Follow-ups**. While a turn is
running the send button shows which action it will take. Long-press it to use the
other action for a single message, or hold `Cmd` while sending from a hardware
keyboard. The button only offers Steer when the running agent supports it.

## Plan and Build on mobile

Plan mode is off on a new phone. Turn it on under **Settings > Threads > Legacy > Plan Mode**; the
setting belongs to that phone and does not follow the desktop app. With it on, both a new task and
an open thread show a **Build** or **Plan** button beside the model; tap it to switch, and the
next message you send uses that mode. A thread that is already in Plan mode keeps the button even
with the setting off, so you can always switch it back. In an open thread you can also type
`/plan` or `/default`. Providers without a Plan mode never show the button.

## Queue messages offline on mobile

Mobile keeps local copies of draft attachments, so you can preview them and queue
messages while disconnected. Uploads resume when you reconnect. Drafts and queued
messages survive app restarts. Signing out of CodeWrench Connect keeps that work on your
device until you sign back into the same account.

## Custom models

On web and desktop, use Settings → Providers → **Models** to add an unlisted model with a custom
name and options. Only options supported by the provider integration affect turns. Antigravity
uses its account catalog and does not support custom models.

## Model defaults

CodeWrench remembers your provider, model, and model options for new threads. A
project's configured model takes precedence; resetting that project setting
returns to the remembered selection.

Leaving reasoning level or service tier unset uses the provider's own configuration.

## Routing And Skill Recommendations

In Workbench on web and desktop, open **Routing** beside the composer to compare
reported account allowances and find local skill matches for the current draft.
Opening the panel does not submit your draft for inference. New requests and saved
recommendations follow the environment, project, account and bounded draft. Reopen
Routing after a reload to recover the saved result without paying again. Older
preview versions that used client-generated request IDs cannot recover a lost ID
this way. Refresh updates
account reports and the selected provider’s project skill catalog.

An environment administrator can connect or disconnect an OpenRouter key in the
Routing panel. The key is stored on that server and never returned to clients.
Saving a key does not test it or buy inference; authentication is checked when
you ask Jev. Disconnecting leaves receipts and uncertain charges intact, and
already accepted requests may finish. It does not change coding-provider keys.

When Jev is connected on the environment, **Ask Jev** sends up to 4,000 characters
of the draft and up to three candidate skill descriptions through OpenRouter.
It suggests capability, reasoning effort and a skill. Confidence reflects the
model’s distribution of choices; review the advice before choosing a model or
adding a skill yourself. Automatic routing and skill execution remain off.

The selection budget is $1.00 per environment per New York calendar day, separate
from coding and other API use. A request reserves up to $0.004032 before sending
and records the reported charge afterward, rounded up to the nearest millionth
of a dollar. An uncertain charge stays reserved, including after midnight. The
same request is never automatically sent again. The panel reports unavailable
budget information explicitly and stops new spending if a charge exceeds its
reservation.

## Model Routing Readiness

**Model Routing Readiness** in Routing reports whether the selected account, model
and options have current verification evidence. Missing or expired evidence,
unknown prices, unavailable quota and paid automatic execution remain blocked.
This read-only check does not change your model or make an inference request.
Even current evidence is not permission to start a task: context fit, task fit and
the turn's execution policy must still be checked. Automatic routing remains off.

## Managed Skills

Manage each machine's skill catalog in **Settings → Skills** (or **Open Skills
Settings** in the Auto panel). The page title counts how many skills are
**Available**, and each skill has its own **Available** switch. Skills are listed
by where they came from: your own `~/.claude/skills` folder, installed Claude
plugins, downloaded packs and reviewed manifests. **Turn Group On** and **Turn
Group Off** switch a whole group at once. Changing the catalog needs
administrator access to that machine.

While **Load Only The Skills Each Message Needs** is on, or Jev is connected,
your own skills and those of installed Claude plugins are indexed and turned on
automatically at start and whenever those folders change, without a restart.
A skill you switched off stays off. Downloaded skills stay off until you install
their pack or turn their group on. None of them cost tokens until a message
uses one. If Jev is disconnected or today's budget is spent, only a skill you
name with `$name` (or a leading `/name`) is attached to that message. Press
**Refresh** to look for new files straight away.

### Skill Packs

**Settings → Skills** starts with **Skill Packs**: curated sets of skills that
CodeWrench downloads from their public GitHub repositories when you press
**Install**. Each row names its repositories (linked) and licenses, and says how
many skills it holds. The packs are **Video and Motion** (GSAP, HyperFrames and a
short-form editing kit, for video, motion graphics and timeline animation) and
**3D and WebGL** (three.js, React Three Fiber, Babylon.js and GSAP, for 3D
scenes and scroll animation).

- Nothing downloads until an administrator presses **Install**, and the download
  needs `git` on that machine. Each repository is fetched at a pinned commit, so
  an install always gives the same files. **Update** appears when a newer
  CodeWrench build pins a newer commit.
- Skills are kept under the skill-library folder in CodeWrench's data folder, one
  folder per repository with its `LICENSE-<name>` file, and are listed in
  `SOURCES.md` there. They are indexed and turned on by the install, which is the
  one-click switch for that pack; a skill you switched off stays off.
- Downloaded skills are instructions your agents follow with your permissions.
  Read a skill before relying on it, and use **Remove** to delete a pack. Remove
  deletes only the folders that pack installed.

You can also install Video and Motion from the first-run **Optional extras** step.

Under **Reviewed Manifests**, **Add Starter Skills** saves the bundled revisions
for reel review, focused code changes, knowledge audits and campaign analytics
without enabling them. Repeating it preserves existing enablement. Dependencies
are checked on the server where the skill is used.

You can also admit a reviewed JSON manifest with its source
revision/hash, review note, permissions, project scope, dependencies and stage
instructions. Admission requires environment administrator access. New revisions
start disabled; enabling a revision replaces the active revision of that skill.
Older revisions remain available for rollback. Disabling a revision prevents
future loads; it does not remove text already placed in a draft. The catalog lives in the server's
SQLite state, outside provider autoload folders.

Routing shortlists up to three descriptions. An explicit `$managed:skill-id`
reference takes priority over keyword matches, while scope and enablement still
apply. Missing dependencies are shown; they cannot hide otherwise usable matches.
**Load plan stage** or **Load review
stage** retrieves only that stage and adds it to your unsent draft. Each stage is
limited to 8,000 characters, and a draft accepts at most two distinct managed
stages. Missing files or executables, disabled revisions and mismatched project
scope prevent loading. Review the draft before sending; skills do not grant
permissions or authorize publishing. Enabling or loading a skill makes no paid
inference request.

The UI measures UTF-8 instruction bytes, not model tokens. Existing global/native skill installations still use their
provider's normal discovery behavior. This feature does not remove that roster
or automatically invoke skills. Native mobile catalog controls are not yet available.

## Quote an assistant response

On web and desktop, select text within one assistant response and choose
**Cite in composer**. You can add a comment about the quote and write instructions
around it.

Select the quote in a draft or sent message to return to its source. If the source
is unavailable or has changed, the saved quote remains readable.

The chip shows your comment when it has one, or a short quote preview otherwise. Use the pencil
button to add or change the comment. To remove the citation, place the caret beside its chip and
delete it like other inline context. Copying, reloading, and restoring a
[stashed prompt](#prompt-stash) keep each comment
with its quote, and sending tells the agent which words were quoted and which comment you wrote.
The quoted text and comment count toward the message limit.

Mobile displays saved quotes and comments, but does not create citations or
navigate to their sources.

## Recall a sent prompt

Press `ArrowUp` in an empty composer to bring back the last prompt you sent in this thread. Press
`ArrowUp` again to go further back, and `ArrowDown` to come forward. Moving forward past the newest
prompt clears the composer. Recall walks the prompts loaded in the thread. Attachments, terminal
context, and other extras from the original message are not restored, only the text you typed. A
composer that holds an attachment or a picked element does not count as empty.

When the composer has text, the arrow keys move the caret as usual. Recall takes over only while
the text is an unedited recalled prompt, with the caret on the first visual line for `ArrowUp` or
the last visual line for `ArrowDown`, counting wrapped lines. Editing a recalled prompt turns it
into a normal draft.

## Predictions

After an agent finishes a turn, an empty composer can show a greyed-out prediction of your next
message. Press `Tab` to put it in the composer, where you can edit it; it is never sent for you.
Press `Esc` to dismiss it, or just start typing. A dismissed prediction does not come back for
that turn.

The prediction is written from the end of the agent's reply, your last message, and a few of your
earlier messages in the thread, which are used only to match how you write. Not every turn gets
one. Each prediction is a request to your text-generation model and counts toward that provider's
usage. Turn it off under **Settings > General > Show predictions**; the setting is per device.

Predictions appear on web and desktop. The mobile app does not show them.

## Edit an earlier prompt

On web and desktop, choose **Edit from here** beneath a sent message to rewind
the conversation to before that message. Choose **Revert and keep changes** to
leave workspace files as they are, or **Revert files too** to restore them as well.
File restore is only offered for threads running in a worktree, and it is
refused when another thread or agent session also uses that directory, a folder
inside it, or a folder that contains it, since
restoring would erase their changes. A thread that works in the project directory
rewinds the conversation only. The selected prompt and its attachments return to the composer for editing and
resending. Any unsent draft stays above the restored prompt.

This removes the selected message and later conversation from the active thread
and provider history. It does not undo external actions or separate provider
memory. The action is available only when the provider supports rewind.

## Prompt stash

On web and desktop, press `Cmd+S` on macOS or `Ctrl+S` on Windows and Linux to save
the current prompt and its attachments for later. Wait for uploads to finish first.
With an empty composer, the same shortcut restores a single stash or opens the
stash menu when there are several.

Stashes containing uploaded files must be restored in their original environment.
Those files are retained for 24 hours. After an upload expires, restore the prompt
and use **Attach again** or remove the missing file before sending.

## Voice input on desktop

Click the microphone beside the composer, or press `Cmd+Shift+Space`, and speak. Press the
shortcut again to stop and transcribe, or `Esc` to discard the recording. Your words appear
greyed in the draft while you speak and settle in when you stop. The live preview pauses
after a minute of recording; the final text still arrives. Change the shortcut under
**Voice: Toggle Dictation** in Keybindings.

Transcription runs on your computer and the audio never leaves it. On a Mac, dictation uses
Apple's built-in on-device speech by default: nothing to install, and words appear as you
speak. The first time, macOS asks to allow Speech Recognition and the Microphone; if you said
no, turn them on in System Settings → Privacy & Security. Whisper takes over when Apple's
speech is not available (older macOS, a language your Mac cannot recognize offline) or when
you choose it under **Settings → General → Dictation engine**.

Whisper needs `whisper-cpp` and `ffmpeg`; run `brew install whisper-cpp ffmpeg`. It uses the
most accurate Whisper model it finds. When it only finds a small one, **Settings → General →
Voice dictation** (or the download button beside the microphone) fetches the accurate
model once, about 574 MB. None of this applies while Apple's speech is in use.

### Voice key: talk from any app

Press the voice key and speak. Listening starts as you press: tap it and it keeps
listening until you tap again (or stop talking; a two-second pause finishes the recording),
or hold it and it finishes when you let go. With a draft open in CodeWrench the words go into that draft for
you to review. From any other app they start a new thread without a project on your
default model. A small pill above every app shows that CodeWrench is listening, the words
as they are heard, and, before a spoken command is sent, three seconds to press `Esc` or
tap the key to send at once.

On a Mac the voice key is Fn (Globe) by default; Right Option, Right Command or a shortcut
you record are the alternatives, and on Windows and Linux it is always a recorded shortcut
(`Ctrl+Shift+V` until you change it). Choose the key, tap or hold, the pause, the wait
before sending and the sounds under **Settings → General → Voice key**, where it can also
be switched off. Pressing another key together with the voice key never starts a recording,
so Fn shortcuts keep working. If Fn is the key, set **System Settings → Keyboard → Press
Globe key to** to **Do Nothing**; Settings warns when macOS will react to Fn as well.

## Live conversations with agents

Open an agent's conversation and choose **Talk**. ElevenLabs V4 Turbo is the default
voice provider, with Scribe realtime for listening. Connect an ElevenLabs API key in
the Talk panel on the machine where the agent runs. GPT-Live-1 remains an optional
provider with its own OpenAI key. End the call before changing providers.

Your existing agent handles the conversation using its current model, tools, history
and permissions. Speak naturally, including corrections while it works. Finished
utterances become messages in the thread. ElevenLabs reads brief progress, results
and requests for attention aloud. Approval prompts still need a response in the app.
Your agent's response time depends on its model and current work.

Speaking interrupts playback without cancelling work. **Mute** silences the microphone;
the connection remains open and billed. **End call** releases the microphone while
work continues. **Stop agent work** separately requests cancellation. The call stays
with its original agent when you switch tabs. Confirmed session expiry reconnects
automatically; after other connection failures, use **Resume conversation**.

Audio goes directly to the selected voice provider. Permanent keys stay on the
selected machine's server. The app connects to ElevenLabs with short-lived tokens;
provider retention follows your ElevenLabs account settings. OpenAI recording
storage is disabled for GPT-Live sessions. Existing dictation is unchanged.

ElevenLabs bills generated speech and transcription, plus your existing agent usage.
Standard published rates are $0.04 per 1,000 generated characters and $0.39 per hour of
realtime transcription; promotions and account pricing may differ. The panel shows
connected time and characters submitted, including speech you interrupt. GPT-Live-1
costs $0.05 per connected minute plus agent usage. Ending the call stops voice usage;
muting does not. Phone calls and native mobile voice controls are not included yet.

## Voice input on iPhone

On supported iPhones with iOS 26 or later, use the composer's microphone to record,
then confirm to transcribe. Text is inserted where your selection was when
recording started, ready for you to review and edit before sending.

The first use may download Apple's speech model and needs a network connection.
Later transcription works offline for that language. Recordings can be up to five
minutes long. Canceling, leaving the screen, or an audio interruption discards the
recording and preserves your existing draft. While recording, the screen stays
awake; it can sleep normally once recording stops.

Transcription runs on your device. CodeWrench deletes the temporary audio after
transcription or cancellation; only the message text is sent when you submit.

## Queued messages

On web and desktop, the composer shows **Interrupt** while the agent is working and the draft is
empty. Adding text or attachments replaces it with a steer arrow. Click it to send a message into
the active turn, or press `Enter` on desktop. Hold `Cmd` on macOS or `Ctrl` on Windows and Linux to
switch the button to a queue icon. Click while holding that key, or press `Cmd+Enter` or
`Ctrl+Enter` on desktop, to queue the message for after the active turn.

Queued messages appear above the composer. Rows show a thumbnail of any attached image alongside
the text. Drag a row by its handle to reorder it, use the handle's arrow keys, promote the message
to a steer, or remove it.

If the server restarts, saved queued messages keep their order and are held. Press
**Resume** in an empty composer on web or desktop, or **Resume queue** in the queue
sheet on mobile, to continue. You can edit, reorder, or remove held messages without starting them.

The pencil on a queued row opens that message in the composer for editing. The original message
stays in the queue until you save, and its row is highlighted while you edit. The message's
attachments appear above the text with a remove control, and new images can be added the usual way.
The checkmark saves the queued message in place; **Cancel** on its row leaves it unchanged. Whatever
you had typed in the composer before starting the edit is restored afterwards. If the queued
message starts or is removed while you are editing, the edit ends: changed content moves into the
composer when it is empty, and is discarded otherwise.

## Commands and skills

Type `/` for commands or `$` to add a skill from the selected environment and
provider. On mobile, both are also available before starting a thread on
**New task**.

The slash menu also includes skills unless you turn off **Settings → General →
Show skills in slash menu**. Only skills enabled for the provider are listed.

After you add or change skills, plugins, or MCP servers, use **Restart agent
session** in the command palette on web and desktop. The conversation continues,
and your next message starts the agent again with the new setup.

Provider commands must start the message to run. CodeWrench commands such as
`/model` and `/plan`, and skill mentions, work on any line.

Send `/compact` in an existing conversation to reduce context usage when the
provider supports it. Web and desktop also offer compaction from the context meter.

## Context in your message

Context you attach lands where your cursor is, as a chip inside your text: a terminal excerpt,
a review comment from a diff or file, a preview annotation, a note on a video or image
(see [Reviewing videos and images](#reviewing-videos-and-images)), or a file. You can type before and
after a chip, move it by cutting and pasting, and delete it like a character. Hover a chip for
its brief details. Select a terminal excerpt to open its captured output, or select a review
comment, picked element, or preview annotation to open its full details. Chips read as "Terminal
excerpt, Terminal 1 lines 3-4" and similar to screen readers.

A pull request appears as its icon and number. Its color reflects whether it was open, draft,
merged, or closed when it was attached. Select it to inspect the captured title and branches,
then choose **Open pull request** to visit the pull request. On web and desktop, type `#` to browse the newest
pull requests in the current project's repository. Continue typing digits to filter the recent list
by any part of its pull request numbers. A complete number is also resolved directly, even when that
pull request is older than the recent list. Type a single word after `#` to search pull requests in
the repository by text. Choose a result to insert it as a chip.

Another thread can be context too. Type `@` followed by part of its title to pick one from
the same server, or on web and desktop drag a thread out of the sidebar and drop it on the
composer; a multi-selection drops together. The chip shows the thread's current title and
opens it when selected. Your prompt only carries a reference: the agent reads the thread's
history on demand, so attaching a long thread costs nothing until the agent looks. Attaching a
thread does not change it, and the agent cannot send messages to it unless you ask.

Images keep their thumbnail shelf above the text and also get a chip at your cursor, so you can
say exactly which image you mean. Deleting an image chip leaves the image on the shelf; removing
the thumbnail asks first when the image is still mentioned in your text, then removes both. Files
exist only as chips: deleting a file's last chip removes the file from the message.

Copy text that holds chips and paste it into another draft, in the same thread or another one,
and the chips come along with what they point to. Images and files are fetched again from the
environment they came from; while that happens the chip shows a dashed outline, and if it cannot
complete CodeWrench tells you and leaves the chip for you to remove or replace. A chip whose
context is no longer available shows the same dashed outline; hover it for what to do.

Copying a message with the copy button, or copying text out of it, gives other apps readable
Markdown with a link in place of each chip. Older messages that were sent before chips still
show their context. Stashing a prompt keeps its chips and what they point to; restoring brings
them back.

On mobile, tap a chip to inspect its content. File references open the current file; attached
files show the copy that was attached to the message.

## Attached files

Select a file chip in your draft or a sent message to preview it. Code and JSON use syntax
highlighting; Markdown, HTML, CSV, and TSV offer rendered and raw views. Audio files have
playback controls. Large text files show a limited preview; save the file to read it in full.

On web and desktop, files open beside the conversation with the same controls as a workspace
file: a header row with the view toggle, **Copy contents** and **Save file**. On mobile, documents
open in the same file screen as workspace files; its menu holds **Copy contents**, **Save or
share** and **Open in file viewer**. Pictures, videos and PDFs keep their native viewers, and
other document formats such as Word or Pages open in the device's own viewer when it has one.
If nothing on the device can show a format, save or share it to open it elsewhere.

## Images and videos in messages

Select an image or video attachment or link to preview it. Playback support depends
on your browser or device; save an unsupported video to open it in another app.

On web and desktop, right-click media to save it or copy its path or URL. On mobile,
touch and hold an image or video thumbnail and choose **Save or share**. On iOS,
return to the thumbnail to open this menu after watching a full-screen video.

File links refer to the environment's machine, including when you connect remotely.
Previews use the original file, even outside the workspace. Moving or deleting it
can break the preview, so save a copy if you need to keep it.

## Reviewing videos and images

On web and desktop, open an mp4, mov, m4v, webm or mkv video, or a png, jpg, webp or gif
image, from the conversation's folder to review it beside the chat. Videos get play and pause,
a timeline of thumbnails, playback speed, and frame stepping. The keys work while the viewer
has focus:

- `Space` plays or pauses.
- `Left` and `Right`, or `,` and `.`, step one frame; hold `Shift` to step one second.
- `I` and `O` mark the start and end of a range at the playhead.
- `Esc` clears the region and range you are drafting.

To say what should change, drag on the picture to circle a region, drag handles to adjust it,
and drag across the timeline (or use **Mark in** and **Mark out**) to select a range. Use either
or both. Without a range, a note on a video points at the frame on screen. Type the comment and
choose **Add to message**: the note becomes a chip in your message, like a picked browser element.

When you send, the agent receives your comment, the time range and the region as percentages,
and frames from the start, middle and end of the range (one frame for a single moment or an
image) with your region drawn on them. A message carries at most 12 frames, three per note;
if you add more, CodeWrench tells you some frames were left out, and every note still goes with
its comment. Agents can also look at any video or image in the folder themselves, and read the
notes you left open, with the `media_inspect` tool. You can switch this off per agent under
Tool Access, as **Media Review**.

Notes are saved next to the file as `<file>.annotations.json`, so a review stays with the media.
Sending a message does not resolve a note; choose **Resolve** on it in the notes list. If the
folder is read-only, notes are kept for the session only and the viewer says so.

Frames and thumbnails are made by `ffmpeg` on the machine running the server, so remote
connections work the same way. Without `ffmpeg`, the video still plays and notes still send, but
without thumbnails or frames. Install it with your package manager, for example
`brew install ffmpeg` or `apt install ffmpeg`. Mobile shows these notes in sent messages but does
not create them. Files outside the conversation's folder, and svg files, open in the plain viewer.

## Files outside the workspace

Follow an agent's file link to read a report or other file outside the workspace.
These files open read-only. An HTML file outside the workspace cannot load scripts,
styles, or images from neighboring files.

## HTML and PDF files in the file viewer

On web and desktop, HTML and PDF files open as rendered pages. Switch an HTML
file to source view to read its markup; a link to a specific line opens source
automatically. HTML previews cannot access your CodeWrench session.

On mobile, select a PDF attachment or link to open it. iOS uses the native viewer;
Android opens a compatible installed file viewer.

## Save passwords for an agent

Ask an agent to request a saved credential instead of pasting a password into chat.
Its request appears above the composer with a masked field and **Save securely**.
Check the purpose and allowed website before saving. A request from another agent,
such as a teammate working for the conversation you have open, appears in the same
place and names the agent that asked. A dialog is used only when no conversation is
on screen. Manage or delete saved values in the agent's **Secrets** panel.

Once you save or decline, the agent carries on by itself. If another agent gave it
the work, that agent receives the result and continues too; you do not need to send
"continue".

The agent can fill an allowed browser page using the secret's name; the value stays
out of conversation messages. Storage is on the selected environment's server.
An agent with unrestricted shell access on that machine can still access its files.
