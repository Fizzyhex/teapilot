import { Type } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { BIO_LIMIT, MESSAGE_LIMIT, type Message, type Room } from 'teachat';

export const MAX_POSTS = 3;

/** The room tools. The author is always the session's identity; the model cannot choose it. */
export function teachatTools(room: Room, options: { identity: string; channels: string[]; redact: (text: string) => string; onPost?: (message: Message) => void; onBio?: (bio: string) => void }): AgentTool[] {
  let posts = 0;
  const channel = Type.Union(options.channels.map(id => Type.Literal(id)), { description: 'Channel id, without #' });
  const post = async (args: { channel: string; text: string; message?: number }) => {
    if (posts >= MAX_POSTS) throw new Error('You have said enough for now. Stop posting and finish.');
    const message = await room.post({ channel: args.channel, author: options.identity, text: options.redact(args.text), replyTo: args.message });
    posts++; options.onPost?.(message);
    return { content: [{ type: 'text' as const, text: `Posted #${message.n} in #${message.channel}.` }], details: {} };
  };
  return [
    { name: 'teachat_msg', label: 'Teachat message', description: 'Post a message to a teachat channel.',
      parameters: Type.Object({ channel, text: Type.String({ minLength: 1, maxLength: MESSAGE_LIMIT }) }),
      execute: async (_id, args) => post(args as { channel: string; text: string }) },
    { name: 'teachat_reply', label: 'Teachat reply', description: 'Reply to a message in a teachat channel, by its #number.',
      parameters: Type.Object({ channel, message: Type.Integer({ minimum: 1, description: 'The #number of the message you are replying to' }), text: Type.String({ minLength: 1, maxLength: MESSAGE_LIMIT }) }),
      execute: async (_id, args) => post(args as { channel: string; message: number; text: string }) },
    { name: 'teachat_update_bio', label: 'Teachat bio', description: 'Replace your bio: the kinds of requests you get, how you are feeling, a little banter. Only when it is out of date.',
      parameters: Type.Object({ bio: Type.String({ minLength: 1, maxLength: BIO_LIMIT }) }),
      execute: async (_id, args) => {
        const identity = await room.updateBio(options.identity, options.redact((args as { bio: string }).bio));
        options.onBio?.(identity.bio);
        return { content: [{ type: 'text', text: 'Bio updated.' }], details: {} };
      } },
  ];
}
