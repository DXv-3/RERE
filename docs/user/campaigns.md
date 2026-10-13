# Campaigns

Campaigns plan, review and publish social posts for a brand, with agents doing the drafting. Open them from the Agents tab, under Campaigns.

## What A Campaign Is

A client is a brand you make posts for, such as Candid Studios or Savage Digital Solutions. A campaign groups the posts for one push under a client, like a launch or a month. Each post has captions, platforms, files and a proposed time, and moves across the board: Draft, Needs Approval, Approved, Scheduled, Posted. A post that did not go out sits in Failed, and one you turned down sits in Rejected.

To start, an administrator adds a client and a campaign. Then ask an agent to draft posts for it, naming the client and campaign. The Studio opens a linked conversation beside your creative work. The Posts view has a button that copies a request you can paste into a thread, and a Templates button for common jobs (see Templates below). Agents save drafts and submit them; they can never approve one.

## Content Studio

Open a campaign’s **Studio** to make a 15–60 second ad. **Create**, **Library**, **Calendar** and **Activity** share the campaign; **Posts** opens its existing post board.

1. In Create, write the brief, choose platforms and a target duration, and optionally set a campaign spending budget. Choose an existing workspace conversation in Campaign AI and save. **Draft storyboard with AI** and **Revise storyboard with AI** add the campaign and saved brief to that conversation’s composer; read the request and send it yourself. It uses the conversation’s normal model selection and approvals.
2. Edit and arrange scenes, including references, narration, trim starts and captions, then save. **Prepare selected scenes** makes proposals only for the scenes you checked; **Prepare generation review** covers all saved scenes. Review each provider, model, prompt and cost before approving individual jobs or the selected batch. A partially failed batch reports which approvals failed and does not regenerate or retry jobs automatically.
3. In Library, drop image, video or audio files into the upload area, or import existing workspace assets. Search by media type and approval state, listen to audio, and inspect provenance before approving. To reuse an approved asset, select its source campaign; Studio creates an independent copy in this campaign’s workspace, records the source, and asks you to review the new copy. Compare variants side by side and select one for each scene in Create. For an uncertain generation, find its existing provider job receipt and use **Resume polling** on that job; this reconnects to the existing job without submitting another paid generation.
4. Choose a render format and audio track; square and landscape require an explicit crop-or-pad choice. Source sound is off unless you select **Retain source sound**. Narration requires its own explicit allowance approval. Review the finished video, then approve that render and **Export to draft post**. Each render keeps the scene revision used to make it: later storyboard edits do not alter an older render. You can unapprove assets or renders. Revisions need a new render and review. Export creates a post draft, not a published post; edit its captions, platforms and schedule through Calendar or Posts and use the normal post approval flow.

The budget panel separates the campaign limit, reserved spending, available budget and provider-reported charges. An unreported charge stays unknown. **Activity** brings generation, narration and render attempts together. A narration that failed before submission can retry its preflight; an uncertain paid request must be reconciled with existing audio instead of submitted again. Interrupted renders keep their source footage and can be revised and rendered again.

Create also offers editable product demo, testimonial, offer and before/after templates based on the saved brief and brand notes. Preview and append a proposal, then edit it and select supported models. Templates do not generate media or spend money.

Unknown-price allowances reserve money against spending limits; they are **not provider quotes or billing ceilings**. Review the combined known estimates and unknown-price reservations before batch approval, and check the provider’s usage page for actual charges. Scene generation and narration share the campaign budget.

Concurrent changes preserve your draft and show the newer revision; review it before keeping your edits or loading the latest. Calendar uses your browser’s timezone and filters the campaign’s existing posts by platform.

## The Three Modes

The mode decides how much you stay in the loop. A client has a default mode, and a campaign can set its own.

- **Ask Me First**: every post waits until an administrator approves it. This is the default.
- **Report When Done**: posts an agent finishes go out at their scheduled time, and the agent tells you what it posted.
- **Auto Publish**: posts go out at their scheduled time with no report beyond the publish log.

Only an administrator can change a mode, and the two modes that publish without asking ask you to confirm first. Each post records which mode it went out under and who approved it.

## Reviewing And Approving

Open a card to see the whole post. While it is a Draft or waits for approval you can edit the captions, platforms, time and files. An edit saves it as a Draft again. Problems that would stop it from going out, such as a missing caption or a phrase from the client's do-not-say list, are listed in the post before you try.

- **Approve** moves a post toward publishing. A time in the future makes it Scheduled.
- **Request Changes** asks you what should change, sends the note to the agent that made the post and puts the post back to Draft.
- **Reject** turns the post down. **Delete** removes it.
- **Publish Now** approves a post and sends it at once.
- **Retry** sends a failed post again.

Only administrators can approve, publish, reject, delete or change a mode. Anyone who can use threads can write drafts and submit them.

## Publishing Is Off Until You Turn It On

Nothing is sent anywhere until you switch publishing on in Settings, under Connections, in Campaign Publishing. Until then approved posts wait on the board. Turning it on asks you to confirm, because posts that are already approved and due will go out.

## Where Posts Go

Choose a publishing service in the same place.

- **Export Folders** saves each approved post as a folder with its files and a caption for every platform, ready to post by hand. A post made from a project's thread is saved in that project. Posts with no thread go to the export folder you set.
- **Savage Digital Solutions Marketing Engine** posts to the accounts the engine has connected. Enter its base address and key, press Save Changes, then Test Connection. The key is stored on the server and never shown again; Settings only says that a key is saved. In each client's settings, enter the client's id in the publishing service.

The engine keeps its own switches. If it has paused a client, CodeWrench shows the failure and does not override it.

## Files

A post's pictures and videos come from the project folder of the thread that made it, or from links. A folder file opens in the media viewer, where you can play it and circle what should change. Linked files open in your browser.

On a card, a picture shows as itself and a video shows a real frame from it once the server has cut one. Until then, and when no frame can be cut (no thread, or ffmpeg is missing), the card shows a film icon. Frames are kept, so the board does not ask again every time something changes.

**Public links.** Beside each folder file the post shows its public link with a Copy Link button, or "No public link yet". Get Public Links makes one for each file that does not have one: it uploads the file to cloud storage, or has this server serve it (see Cloud Storage below). If public links are off, the post says where to turn them on (Settings, Connections, Campaign Cloud Storage). Only administrators can make links. Anyone who has a link can open the file. When this server made the links, **Stop Sharing** ends them at once.

## Editing Video

An agent can make an edited copy of a video in its thread's folder: trim it, join clips, resize it for a platform, burn in captions, mute it, pull out the sound, or save a still frame. Ask in the thread, for example "trim clip.mp4 to the first 20 seconds and make a vertical version with captions". The agent needs the Media Review tool group switched on in its profile, and ffmpeg must be installed on the machine that runs the server.

- **Trim** keeps the part between two times. **Join** puts two to ten clips one after another.
- **Resize** makes the video vertical (1080 by 1920), square (1080 by 1080), landscape (1920 by 1080) or 4 by 5 (1080 by 1350). Crop fills the shape and cuts the edges evenly. Pad keeps the whole picture and fills the rest with a blurred copy of it. It works on pictures too.
- **Captions** are burned into the picture, white with a dark outline at the bottom centre. Curly braces in a caption show as parentheses and backslashes as slashes.
- **Mute** removes the sound. **Extract Audio** saves the sound as an m4a file. **Poster** saves one frame as a jpg.

Every edit makes a new file beside the original, named like `clip.trim-1.mp4`. The original is never changed and an existing file is never overwritten. Joining and most other edits re-encode the video as H.264, which loses a little quality; the agent tells you when it did. The agent looks at the result before it says the work is done and tells you which file it made. An edit refuses files outside the thread's folder, files over the size and length limits, and files that are not really videos. A result over 2 GB is thrown away.

## Cloud Storage

The marketing engine fetches a post's pictures and videos from the web, so a file that only exists in a project folder needs a public link first. Cloud storage makes one: CodeWrench uploads the file to a bucket you own and records the link on the post.

**Files uploaded to cloud storage are public. Anyone who has a file's link can open it.** Use a bucket meant for public files, and only post material you are happy to have public. Nothing is uploaded unless you switch cloud storage on, and only pictures, video and audio files from the post's thread folder are ever uploaded.

Set it up in Settings, under Connections, in Campaign Cloud Storage. Any S3-compatible service works. For Cloudflare R2:

1. In Cloudflare, create a bucket and turn on public access for it (an `r2.dev` address or your own domain). Copy that public address.
2. Create an API token for R2 with Object Read and Write on that bucket. Copy the Access Key ID and the Secret Access Key.
3. In Campaign Cloud Storage, paste the **Storage Address** (`https://<account id>.r2.cloudflarestorage.com`), the **Bucket** name, the **Public Address** from step 1, and the two keys. Leave Region as `auto`. The folder prefix (`campaigns/` by default) goes in front of every uploaded file.
4. Press Save Changes, then Test Storage. It uploads a tiny file, opens it through the public address and deletes it. Fix whatever it reports before going on.
5. Turn Cloud Storage on and confirm.

The two keys are stored on the server and are never shown again; Settings only says that keys are saved. Removing them also turns storage off.

Once it is on, a post with folder files and no links is uploaded just before it is sent to the marketing engine. A file already uploaded for a post is not uploaded again. If an upload fails the post fails with the reason and nothing is sent. To get the links without publishing, open the post and press Get Public Links. Files are stored as `<prefix><client>/<campaign>/<post id>/<file name>`. If storage is off, a post with folder files and no links is refused by the engine with "This post's media has no public address yet."

A file that was already uploaded for a post is not uploaded again, even if you change the file afterwards. Save an edited file under a new name (the agent's edits always do) and add that one to the post.

### This Server

If you have no bucket, CodeWrench can serve a post's files itself. In Campaign Cloud Storage choose **This Server** under Where Files Are Kept, enter the **Public Address** (the https address you reach this server at from the internet, such as `https://code.example.com`), press Save Changes, then turn public links on and confirm. Once it is on, press Test Storage: the server fetches a tiny file from its own public address and tells you plainly if it cannot.

It only works when this computer can be reached from the internet at that https address. A laptop on a home network usually cannot; a server with a domain name, a tunnel or a reverse proxy can. A post's pictures, video and audio are the only files ever served, and only from the post's thread folder.

**"Public" means anyone with a file's link can open it, with no sign-in.** The link carries a long random code, so it cannot be guessed, but it works for anyone who is given it or sees it (the marketing engine and the social platforms see it, for instance). Links do not expire. They live until you stop them:

- Open the post and press **Stop Sharing**. That post's links stop working at once and are taken off the post; Get Public Links makes new ones.
- Turn public links off, switch to Cloud Storage, or change the Public Address. Every link this server made stops working and is taken off its post.
- Reject or delete the post, or take a file off it.

A platform that has already downloaded a file keeps its copy, and a browser may keep one for up to an hour. Stopping sharing cannot take those back.

## Making Images And Video

Agents write captions and plans on whatever model they run on. Pictures and video need a service that makes them, and a chat subscription alone cannot make video. Nothing is made, and nothing is spent, until you choose a generator. The choice for images and the choice for video are separate, and both start as None.

Choose them in Settings, under Connections, in Campaign Publishing.

### Generate On The Board

Open a campaign’s **Posts** view and press **Generate** (administrators only; everyone else sees why it is off). Choose Image or Video and describe what to make.

- The form says which service will make it. If that choice is None, it says so and points you to Settings, Connections, Campaign Publishing instead of sending anything.
- The client's brand notes and do-not-say list sit beside the description. If your description uses a phrase from the list, the form warns you as you type. It does not block you.
- Shape is the aspect ratio. Length, quality, reference-image requirements and the Sound switch follow the chosen model’s supported controls. MuAPI controls source audio; Studio can mute it during assembly.
- **Save Files In** chooses the thread whose project folder receives the file. That is what lets you open it in the viewer and attach it to a post that can be uploaded. The export folder from Settings is the other choice, and only works if one is set.
- Before you send it, the form shows what the client has used this month against its limit, and what this job is expected to cost. When the price is unknown, enter a positive dollar allowance. Starting approves and reserves that allowance against the monthly limit; it is not a provider quote or billing ceiling. If the limit would refuse the job, the form says so and does not send it.

Pressing Start Generating (or Approve Allowance And Generate for unknown pricing) begins at once and spends from the client's budget. The **Generations** list under the board shows the client's recent jobs, one row each: a picture or video frame once it is done, the status in words and an icon, what was asked for, whether a person or an agent asked, and the cost note.

- **Approve** starts a job an agent asked for under Ask Me First. **Cancel** stops one that is waiting, queued or running. Both are for administrators; others see them switched off with the reason.
- A finished job has **Add To A New Post**, which opens a new post with the file already attached and the campaign chosen, and **Open**, which opens the file in the media viewer.
- A failed job shows why.

Settings, under Recent Generations, shows the same list for every client, with an Open Campaigns button. Approving works from either place.

## Templates

The Templates button on a campaign, and the four buttons in an empty campaign, offer starting points: Weekly Reel Batch, Turn A Blog Post Into Five Posts, Monthly Campaign Calendar, and Repurpose A Long Video Into Shorts. Each asks two or three questions, such as the blog link, the video's path in the project folder, or the month. Copy Request then puts a finished request on your clipboard and says "Copied. Paste it into a thread with an agent."

The request names the client and campaign, the campaign tools the agent should use, the client's brand notes and do-not-say list, and the approval mode in force, so the agent starts with everything it needs. Nothing is sent from the template. You read the request, paste it where you want it and send it yourself.

- **OpenRouter** makes images and video with your own OpenRouter key. Paste the key, press Save Changes, then Test Connection. The key is stored on the server and never shown again. You can type a model name for images and another for video; empty uses the built-in choice. OpenRouter charges your account directly.
- **Savage Digital Solutions Marketing Engine** makes video only. It uses the address and key you already entered for publishing, and the client needs its id in the publishing service.
- **A Local Server** makes images only, through any server that speaks the OpenAI images API. Enter its address and the model name. No key is needed and nothing is charged.
- **This Computer's GPU** makes images, and short videos from a still image, on this computer's own graphics card. Nothing leaves the machine and nothing is charged. See below.

A job runs in the background and survives a restart. When it finishes, the file is saved in the project folder of the thread that asked, under `campaigns/<client>/<campaign>/generated/`, or in the export folder if there was no thread. An agent that asked is told where the file is, so it can look at it and attach it to a post.

**Spending.** Each client can have a monthly limit. A job that would pass it is refused, and the message says how much is used. The cost is estimated before a job starts and shown with it. For a model with unknown pricing, an explicit positive allowance is reserved against the limit. This reservation is not a provider quote or billing ceiling. Check your provider's usage page for the real figure.

**Who may start one.** Starting a generation spends money, so only administrators can start one, press Test Connection, or change these settings. An agent can ask for one too, but only a client or campaign set to Report When Done or Auto Publish lets it start. Under Ask Me First the job waits for you to approve it, under Generations on the campaign board or in Settings under Recent Generations, and nothing is spent until you do. Cancel stops a job that has not started. A video that is already running is dropped when it comes back, but the provider may still charge for it.

**If a restart interrupts a job.** A saved provider receipt lets polling resume without resubmitting. If submission is uncertain, the job may already have been charged; it is not automatically resubmitted. For a Studio job, enter its existing provider receipt and choose Resume polling in its generation review card.

### This Computer's GPU

This runs an image model on the server's own graphics card. It is free, and the prompt never leaves the machine. It is slower and lower quality than a hosted model, and pictures with writing in them come out garbled (Best quality spells short signs correctly). For pictures of people, choose Best quality.

**What it needs.** An NVIDIA graphics card, and a Python with PyTorch and diffusers installed (Good for people and Best quality also need bitsandbytes). The simplest way is a Python environment of its own at `~/.codewrench/localgen/venv`: leave Python empty and CodeWrench uses it first. In Settings, choose This Computer's GPU for images. Leave Python empty to let CodeWrench look for one, or paste the full path of the Python you want. Press Test This Computer's GPU to see, line by line, what is found and what is missing.

**Models.** Small, fast needs about 3 GB of free graphics memory, downloads about 4.3 GB, and makes a picture in seconds (LCM Dreamshaper v7, MIT license). Better quality needs about 6.5 GB free, downloads about 6.9 GB, and took about 16 seconds for a 1024 by 1024 picture on a 16 GB card (Stable Diffusion XL base 1.0, Open RAIL++-M license). Good for people needs about 7.5 GB free (it used 6.9 GB at its peak), downloads about 34 GB, and takes about 15 seconds per 1024 by 1024 picture once its files are cached by the computer, and longer the first time (FLUX.1 schnell, Apache-2.0 license). It gets the number of people, faces and hands right far more often than the others, but writing on signs still comes out garbled. The download comes from an open copy of the official files, because the official page asks for a Hugging Face login. Best quality needs about 9 GB free (it used 8.3 GB at its peak, 8.8 GB counting the card's own overhead), downloads about 33 GB, and takes about 20 seconds per 1024 by 1024 picture (Z-Image Turbo, Apache-2.0 license). In side-by-side tests it followed the prompt much more closely than FLUX.1 schnell (who is doing what, the named objects), its faces and hands are cleaner, it looks more like a photograph, and it spells short signs correctly. It is not perfect: it can ignore a detail such as a person's sex, and a long run of small text is still garbled. Its transformer is stored in 32-bit, which is why the download is as large as FLUX.1 schnell's even though it is loaded at 8-bit. All four licenses allow commercial use. You can also point at a folder that holds a diffusers model you already have, and that model's own license applies.

**Getting better pictures.** Best quality runs its 6 billion parameter picture part at 8-bit and its 4 billion parameter text reader at full 16-bit precision, one at a time, to fit about 9 GB. At full 16-bit precision the picture part alone is about 12.3 GB, so it needs roughly 13 to 14 GB of the card free, which means stopping the text models and speech services overnight (the card has 16 GB in total). That would give slightly cleaner fine detail; the gain over 8-bit is small. Larger open models such as Qwen-Image (20 billion parameters, Apache-2.0, a 57 GB download) are better still at long text and complex scenes, but even at 4-bit they need about 11 GB for the picture part alone, so they would need most of the card to themselves. This has not been tried on this computer.

**The first use downloads the model.** Press Download Model once after saving. Nothing is downloaded while a picture is being made; if you skip this step the job fails and tells you to do it. Models are kept in the Models Folder, which is `~/.codewrench/localgen/models` unless you change it.

**It shares the card and never pushes anyone out.** Text models usually hold much of the graphics memory. Before each picture the program checks how much is free. With the default choice, Use A Smaller Model, a model that does not fit is replaced by the largest smaller one that is downloaded and does fit, at its smaller size, and the result says so. If none fits it stops and says so, for example "The GPU has 2.1 GB free and this model needs about 3.0 GB. Text models are using the rest." It does not unload or stop anything. One picture is made at a time, and one that takes more than 10 minutes is stopped.

**Doing it at night.** In Settings, set When The Graphics Card Is Busy to Wait Until There Is Room. A picture whose model does not fit is then not made with a smaller one and does not fail: it stays in line with the note "Waiting for the graphics card: 3.3 GB free, this model needs 6.5 GB." and is tried again every few minutes. You can also set Only Start After and Stop Starting At (for example 22:00 and 06:00, on the server's clock; a window that crosses midnight is fine). Outside those hours a picture waits with the note "Scheduled for tonight after 22:00." A waiting picture can be cancelled, is still waiting after a restart, does not hold up other generators, and is given up after 24 hours with a plain message. When it finally finishes, the agent that asked is told as usual.

**If a restart interrupts a picture.** It fails with "Interrupted by a restart. Nothing was charged; start it again."

### Video From A Still Image

This computer's graphics card can also make a short video, on the same terms as pictures: free, and nothing leaves the machine. It only works from a still. The picture becomes the first frame and the description says how things move. It cannot make video from words alone. The usual way is to make a picture first (the Best quality model is a good start), look at it, and then animate it. The card is for this server's owner: only administrators can start, approve or set up a job, and a model share lends out the text model only, never the card. Someone else sets up their own generator on their own install.

**What it needs.** The same Python environment as for pictures, plus the `ftfy` package and `ffmpeg`. In Settings, set Video to This Computer's GPU, choose the video model (there is one: Wan 2.2 5B, Apache-2.0 license, which says the makers claim no rights over what it makes), press Save Changes, then Download Video Model once. The download is about 34 GB. A video needs about 7.5 GB of free graphics memory (it used 6.5 GB at its peak for a 5 second clip). Test GPU Video checks all of this line by line.

**How to start one.** On a finished picture in Generations, an administrator can press Make A Video From This. The Generate form opens set to Video with that picture as the starting picture and a box to describe the motion. Choose A Different Picture lists the image files in the thread's folder. The shape (for example 9:16 for a reel), the length (3 to 5 whole seconds) and the quality (480p, which is about 640 by 640 for a square) are on the form. An agent uses `media_generate_image`, looks at the picture with `media_inspect`, then calls `media_generate_video` with the picture's path as the first frame, or with `fromJobId` set to the finished image job. A web link is never fetched for this generator, and a job with no picture fails at once with "This computer makes video from a still image. Choose an image to start from."

**How long it takes, and when to run it.** Once it starts, a 3 second clip took about 3 minutes and a 5 second clip about 5.5 minutes on a 16 GB card, plus about a minute to load the model. A video is stopped after 30 minutes. It shares the card, and one job runs at a time, pictures and videos alike. There is no smaller video model, so when the card has too little room a video always waits (with the same note as a picture) and is tried again every few minutes, whatever When The Graphics Card Is Busy says. The night window applies to video too. It runs best overnight, when the text models are quiet.

**What to expect.** The first frame is the picture you chose. People, clothes and places stay recognisably the same in nearly every clip, and the motion is real and smooth: people turn and lean, a camera pushes in, steam rises. It is not flawless. In our tests a bride's face drifted a little over 5 seconds, a side figure walked out of frame, a customer's hand in a coffee hand-over turned into a blurred shape at the end, lettering on a sign wobbled near the end of one clip, and small keyboard keys blurred. Look at every clip before you use it, make another with a different description if it is wrong, and keep clips short. There is no sound. Expect usable social clips of 3 to 5 seconds, not film.
