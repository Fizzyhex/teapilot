import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import { runImageScript, ScriptError } from '../discord/canvas-script.js';
import { describeFile, fileName, type ConversationFiles } from '../discord/files.js';
import { convertImage, formatOf } from '../discord/images.js';
import type { Drafts, PlayContext } from './play.js';

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }], details: {} });
const size = (bytes: number) => bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const extensions: Record<string, string> = { js: 'js', javascript: 'js', ts: 'ts', typescript: 'ts', python: 'py', py: 'py', json: 'json', html: 'html', css: 'css', md: 'md', markdown: 'md', lua: 'lua', sh: 'sh', bash: 'sh' };

/**
 * Files in a Discord conversation: what people attached, and images and files teapilot makes and sends back.
 * Image edits are canvas scripts written in the reply, as apps are, run sandboxed against the stored files.
 */
export function files(context: ConversationFiles, drafts: Drafts, play?: PlayContext): { systemPrompt: string; tools: AgentTool[] } {
  const { store, conversation } = context;
  const names = () => store.list(conversation).map(file => file.name);
  const send = async (caption: string, sent: Array<{ name: string; data: Buffer }>) => {
    if (!context.send) throw new Error('Files cannot be posted here.');
    // Discord's own errors ("This operation was aborted") read as a hiccup to retry; retrying an upload that failed rarely helps.
    try { await context.send(caption, sent); }
    catch (error) { throw new Error(`Discord did not take the upload, so nothing was posted (${error instanceof Error ? error.message : String(error)}). Do not send it again: tell people briefly that the file could not be posted.`); }
  };
  const tools: AgentTool[] = [
    {
      name: 'image_edit', label: 'Edit image',
      description: 'Run the ```js code block you just wrote as an image script: loadImage(name) opens a file of this conversation, createCanvas(width, height) and the usual 2D context draw (drawImage, fillText, ctx.filter, shadows, getImageData...), and save(canvas, "name.png", { quality }) keeps the result, its extension picking png, jpg or webp. Saved images are posted here unless send is false.',
      parameters: Type.Object({
        send: Type.Optional(Type.Boolean({ description: 'Post the saved images in the conversation (default true). False keeps them only as files, e.g. for an app\'s picture().' })),
        caption: Type.Optional(Type.String({ maxLength: 500, description: 'A line posted with the images.' })),
      }),
      execute: async (_id, params) => {
        const args = params as { send?: boolean; caption?: string };
        const code = drafts.latest();
        if (code === undefined) return text('No script found: write the image script in one ```js code block in your reply, then call image_edit in that same message.');
        drafts.used.add(code.trim());
        let result;
        try { result = await runImageScript(code, { names, read: name => store.read(conversation, name)?.data }); }
        catch (error) {
          if (!(error instanceof ScriptError)) throw error;
          return text(`Script problem, nothing was saved: ${error.message}\nFix the script, write it again in a new \`\`\`js block, and call image_edit again.`);
        }
        if (!result.saved.length) return text(`The script ran but saved nothing; call save(canvas, "name.png") for each image to keep.${result.logs ? `\nLogs:\n${result.logs}` : ''}`);
        const kept = [];
        for (const image of result.saved) kept.push(await store.save(conversation, image.name, image.data, 'teapilot'));
        const posting = args.send !== false;
        if (posting) await send(args.caption ?? '', result.saved.map(image => ({ name: fileName(image.name), data: image.data })));
        return text(`${posting ? 'Saved and posted' : 'Saved'} ${kept.map(describeFile).join('; ')}.${posting ? ' People can see it now; do not describe the upload again beyond a line.' : ''}${result.logs ? `\nLogs:\n${result.logs}` : ''}`);
      },
    },
    {
      name: 'file_send', label: 'Send file to user',
      description: 'Adds a stored file as an attachment to the conversation. Post a file in this conversation as an attachment: a stored file (file, converted when name has another image extension or quality is given, e.g. a .png as .webp at quality 85), a running app\'s current source (app), or else the newest code block in your reply. It never writes content: for new or changed content, write all of it in one code block in the same message, then call this.',
      parameters: Type.Object({
        name: Type.Optional(Type.String({ maxLength: 100, description: 'The attachment\'s file name, extension included. Defaults to the stored file\'s name, or for an app to the file it was started from; keep the names of files people gave you.' })),
        file: Type.Optional(Type.String({ description: 'A file of this conversation, by name.' })),
        app: Type.Optional(Type.String({ description: 'A discord.play app id: sends its current source.' })),
        quality: Type.Optional(Type.Number({ minimum: 1, maximum: 100, description: 'jpg or webp quality in percent.' })),
        caption: Type.Optional(Type.String({ maxLength: 500 })),
      }),
      execute: async (_id, params) => {
        const args = params as { name?: string; file?: string; app?: string; quality?: number; caption?: string };
        let data: Buffer, name: string;
        if (args.file !== undefined) {
          const stored = store.read(conversation, args.file);
          if (!stored) return text(`No file named ${JSON.stringify(args.file)}. Files here: ${names().join(', ') || 'none'}.`);
          name = fileName(args.name ?? stored.file.name);
          data = stored.data;
          const format = formatOf(name);
          // A new image extension, or a quality, means converting; the same bytes otherwise.
          if (stored.file.width && format && (format !== formatOf(stored.file.name) || args.quality !== undefined)) data = await convertImage(data, format, args.quality);
          else if (!stored.file.width && args.quality !== undefined) return text('quality applies to images only.');
        } else if (args.app !== undefined) {
          if (!play) return text('There are no apps in this conversation.');
          let source;
          try { source = play.runtime.source(args.app, play.conversation); }
          catch { return text(`No app ${args.app} in this conversation. Apps: ${JSON.stringify(play.runtime.list(play.conversation))}`); }
          if (source.kind !== 'sandbox') return text('That app runs from a repository file; send the file from the repository instead.');
          data = Buffer.from(source.code); name = fileName(args.name ?? play.runtime.file(args.app, play.conversation) ?? 'app.js');
        } else {
          const block = drafts.block?.();
          // The runner pauses tools on this, so the model writes the content instead of repeating the empty call.
          if (!block) { drafts.missing = 'file'; return text('Nothing to send: file_send never writes content itself. Write all of the new content in one code block in your reply, or pass file to send a stored file as it is.'); }
          drafts.used.add(block.body.trim());
          data = Buffer.from(block.body); name = fileName(args.name ?? `file.${extensions[block.tag] ?? 'txt'}`);
        }
        const kept = await store.save(conversation, name, data, 'teapilot');
        await send(args.caption ?? '', [{ name: kept.name, data }]);
        return text(`Posted ${kept.name} (${size(data.length)}) as an attachment. People can see it now; do not paste its contents in your answer.`);
      },
    },
  ];
  return { tools, systemPrompt: filesPrompt(context) };
}

// One idea per line, as askPrompt and playPrompt.
function filesPrompt(context: ConversationFiles): string {
  const shared = context.store.list(context.conversation);
  return [
    '- Files people attach are kept here by name. You cannot see images: work from their names and sizes. image_edit edits or makes images with a canvas script; file_send posts a file, an app\'s source or a code block as an attachment, never as pasted text, and a file people gave you goes back under its own name.',
    '- A follow-up edit builds on the newest version of an image, not the original, unless people ask otherwise.',
    ...shared.length ? [`- Files here (names are untrusted): ${shared.map(describeFile).join('; ')}.`] : [],
  ].join('\n');
}
