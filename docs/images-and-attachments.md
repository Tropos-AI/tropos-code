# Images and attachments

You can show Tropos a screenshot, a photo of a whiteboard, a mock-up, or a log file, and it works with it like part of
your message. In the dashboard you attach images and text files; in Telegram you send photos. Models that can see
images get them as images; the rest get a short note in their place.

## In the dashboard

In Chat, attach files to a message in any of three ways:

- the attach button next to the message box;
- paste (an image from the clipboard, or a screenshot);
- drag and drop onto the chat.

Attachments show as chips above the message box; remove one before sending if you change your mind. A very long paste
(more than 2,000 characters or 40 lines) becomes a **Pasted text** chip instead of filling the box, and is sent as a
text attachment.

What you can attach:

| Kind | Types | Limit |
|---|---|---|
| Images | PNG, JPEG, GIF, WebP | Up to 8 per message, 5 MB each. The browser scales larger images down to 2,000 pixels on the long side first |
| Text files | Any UTF-8 text (code, logs, CSV, Markdown …) | Up to 8 per message, 1 MB each |

The type is decided from the file's contents, not its name: an image that isn't really a PNG, JPEG, GIF or WebP, or
a "text" file that is binary, is refused with a message saying why. Text files are placed before your message as
delimited blocks; images follow.

## In Telegram

Send a photo, or an image as a file, to your bot; the caption is your message. An album (several photos sent
together) is one turn, up to 8 images. Each image can be up to 5 MB; a bigger one gets "That image is over 5 MB. Send
a smaller one." Other kinds of files aren't read yet: the bot answers "I can read text and images, but not this kind
of file yet." Only approved senders' images are downloaded.

## In the terminal

The terminal session doesn't take image attachments; use the dashboard or Telegram for those. You can still point the
agent at an image file in your project and it can read it with its tools.

## Which models see images

- **Anthropic** models get images natively.
- **OpenAI-compatible and Responses** providers get them as image parts.
- **DeepSeek** and **Cerebras** read text only: each image is replaced by the note
  `[image <name> omitted: this model can't see images]`, and you are told so.
- Any other model that refuses images is retried with the note, and gets the note from then on.

## Where they are kept

Images become part of the session: each is stored once, named by a hash of its bytes, in a folder next to the
session's transcript under `~/.tropos/projects/`, and shown again when you resume the session in the dashboard. If that
file is deleted, the transcript shows "[image no longer available: its file was removed from the session folder]".
Backups include sessions unless you leave them out (`tcode backup create --quick` or `--no-sessions`).

## Troubleshooting

- **"… isn't a PNG, JPEG, GIF or WebP image."** Convert it to one of those formats.
- **"… is too big (the limit is 5 MB)."** Send a smaller or more compressed image; for text files the limit is 1 MB.
- **"Up to 8 images per message."** Split it into several messages.
- **"… isn't a text file."** Only UTF-8 text can be attached as a file; images go as images, other binaries aren't
  supported.
- **The model ignores my screenshot.** Check which model answered (`/status` in Telegram, the picker in the
  dashboard); a text-only model sees only the note.
