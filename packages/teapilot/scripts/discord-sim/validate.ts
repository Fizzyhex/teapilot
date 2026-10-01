// What Discord would refuse, checked offline: the checks discord.js runs when it sends raw JSON, its
// builders' per-field rules, and the API limits the builders leave to the server.
import { ActionRowBuilder, ButtonBuilder, ContainerBuilder, EmbedBuilder, embedLength, FileBuilder, MediaGalleryBuilder, ModalBuilder, SectionBuilder, SeparatorBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, TextDisplayBuilder, TextInputBuilder, type APIEmbed } from 'discord.js';

/** Discord or discord.js would reject this payload; the message names where. */
export class DiscordRejected extends Error {}

type Json = Record<string, unknown>;
const limits = { content: 2000, embeds: 10, embedTotal: 6000, rows: 5, buttons: 5, modalRows: 5 };
// One emoji, including a bare pictograph such as ❤. The v flag is newer than the compile target, not than Node 22.
const unicodeEmoji = new RegExp('^(?:\\p{RGI_Emoji}|\\p{Extended_Pictographic}\\uFE0F?)$', 'v');

/** A shapeshift error as one line: the first failure, with what was expected and what was given. */
function reason(error: unknown): string {
  const value = error as { errors?: unknown[]; expected?: unknown; given?: unknown; message?: unknown };
  if (Array.isArray(value.errors) && value.errors.length) {
    // Object errors pair each key with its error; a nullable field fails both branches, and the constraint is the useful one.
    const errors = value.errors.map(entry => Array.isArray(entry) ? entry[1] : entry);
    return reason(errors.find(entry => (entry as { constraint?: unknown }).constraint) ?? errors[0]);
  }
  const given = typeof value.given === 'string' ? `${value.given.length} characters` : JSON.stringify(value.given);
  return `${String(value.message ?? error).split('\n')[0]}${value.expected ? ` (${String(value.expected)}; got ${given})` : ''}`;
}
function at<T>(where: string, check: () => T): T {
  try { return check(); }
  catch (error) { throw error instanceof DiscordRejected ? error : new DiscordRejected(`${where}: ${reason(error)}`); }
}
/** Runs each setter whose field is present, so a failure names the field. */
function apply(where: string, data: Json, setters: Record<string, (value: never) => unknown>): void {
  for (const [key, set] of Object.entries(setters)) if (data[key] !== undefined) at(`${where}.${key}`, () => set(data[key] as never));
}
const records = (value: unknown, where: string): Json[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'object' || entry === null)) throw new DiscordRejected(`${where} must be an array of objects.`);
  return value as Json[];
};

function checkEmoji(value: unknown, where: string): void {
  if (value === undefined) return;
  const emoji = value as { id?: unknown; name?: unknown };
  if (emoji.id !== undefined) { if (typeof emoji.id !== 'string' || !/^\d{17,20}$/.test(emoji.id)) throw new DiscordRejected(`${where}.emoji: custom emoji id ${JSON.stringify(emoji.id)} is not a Discord id.`); return; }
  if (typeof emoji.name !== 'string' || !unicodeEmoji.test(emoji.name)) throw new DiscordRejected(`${where}.emoji: ${JSON.stringify(emoji.name)} is not a Unicode emoji and has no custom emoji id (Invalid emoji).`);
}

export function checkEmbeds(value: unknown, where = 'embeds'): void {
  const embeds = records(value, where);
  if (embeds.length > limits.embeds) throw new DiscordRejected(`${where}: ${embeds.length} embeds; Discord allows ${limits.embeds}.`);
  let total = 0;
  embeds.forEach((embed, index) => {
    const builder = new EmbedBuilder();
    apply(`${where}[${index}]`, embed, {
      title: (value: string) => builder.setTitle(value), description: (value: string) => builder.setDescription(value),
      url: (value: string) => builder.setURL(value), color: (value: number) => builder.setColor(value),
      timestamp: (value: string) => builder.setTimestamp(new Date(value)),
      footer: (value: NonNullable<APIEmbed['footer']>) => builder.setFooter({ text: value.text, iconURL: value.icon_url }),
      author: (value: NonNullable<APIEmbed['author']>) => builder.setAuthor({ name: value.name, url: value.url, iconURL: value.icon_url }),
      image: (value: { url: string }) => builder.setImage(value.url), thumbnail: (value: { url: string }) => builder.setThumbnail(value.url),
      fields: (value: NonNullable<APIEmbed['fields']>) => builder.setFields(...value),
    });
    total += embedLength(embed as APIEmbed);
  });
  if (total > limits.embedTotal) throw new DiscordRejected(`${where}: ${total} characters across embeds; Discord allows ${limits.embedTotal}.`);
}

function checkButton(data: Json, where: string): void {
  checkEmoji(data.emoji, where);
  const button = new ButtonBuilder();
  apply(where, data, {
    style: (value: number) => button.setStyle(value), label: (value: string) => button.setLabel(value), emoji: (value: { name: string }) => button.setEmoji(value),
    custom_id: (value: string) => button.setCustomId(value), url: (value: string) => button.setURL(value), disabled: (value: boolean) => button.setDisabled(value),
  });
  at(where, () => button.toJSON());
}

function checkSelect(data: Json, where: string): void {
  const options = records(data.options, `${where}.options`);
  options.forEach((option, index) => checkEmoji(option.emoji, `${where}.options[${index}]`));
  const select = new StringSelectMenuBuilder();
  apply(where, data, {
    custom_id: (value: string) => select.setCustomId(value), placeholder: (value: string) => select.setPlaceholder(value),
    min_values: (value: number) => select.setMinValues(value), max_values: (value: number) => select.setMaxValues(value), disabled: (value: boolean) => select.setDisabled(value),
  });
  const built = options.map((option, index) => {
    const item = new StringSelectMenuOptionBuilder();
    apply(`${where}.options[${index}]`, option, {
      label: (value: string) => item.setLabel(value), value: (value: string) => item.setValue(value), description: (value: string) => item.setDescription(value),
      emoji: (value: { name: string }) => item.setEmoji(value), default: (value: boolean) => item.setDefault(value),
    });
    return item;
  });
  at(`${where}.options`, () => select.setOptions(built));
  at(where, () => select.toJSON());
  const min = (data.min_values as number | undefined) ?? 1, max = (data.max_values as number | undefined) ?? 1;
  if (!options.length) throw new DiscordRejected(`${where}: a select needs at least one option.`);
  if (min > max) throw new DiscordRejected(`${where}: min_values ${min} is above max_values ${max}.`);
  if (max > options.length) throw new DiscordRejected(`${where}: max_values ${max} is above its ${options.length} option(s).`);
  if (new Set(options.map(option => option.value)).size !== options.length) throw new DiscordRejected(`${where}: option values must be unique.`);
}

/** The message flag that turns on Components V2. */
export const componentsV2 = 1 << 15;
const v2Limits = { components: 40, text: 4000, section: 3, gallery: 10 };
/** What discord.js builds each Components V2 type with before sending. */
const v2Builders: Record<number, new (data: never) => { toJSON(): unknown }> = {
  9: SectionBuilder, 10: TextDisplayBuilder, 12: MediaGalleryBuilder, 13: FileBuilder, 14: SeparatorBuilder, 17: ContainerBuilder,
};

/** Every `attachment://` name a message's components show. */
export function componentAttachments(components: unknown): string[] {
  const names: string[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) {
      if (key === 'url' && typeof entry === 'string' && entry.startsWith('attachment://')) names.push(entry.slice('attachment://'.length));
      else visit(entry);
    }
  };
  visit(components);
  return names;
}

/** A Components V2 message: no content or embeds, and within Discord's component and text limits. */
function checkComponentsV2(payload: { content?: unknown; embeds?: unknown; components?: unknown }): void {
  if (typeof payload.content === 'string' && payload.content) throw new DiscordRejected('content: a Components V2 message cannot have content; put text in a text display.');
  if (records(payload.embeds, 'embeds').length) throw new DiscordRejected('embeds: a Components V2 message cannot have embeds.');
  const top = records(payload.components, 'components');
  if (!top.length) throw new DiscordRejected('Cannot send an empty message.');
  let count = 0, text = 0;
  const visit = (component: Json, where: string, inside?: number) => {
    count++;
    if (component.type === 10) text += typeof component.content === 'string' ? component.content.length : 0;
    if (component.type === 1) { checkRow(component, where, new Set()); records(component.components, `${where}.components`).forEach(() => count++); return; }
    if (component.type === 11) { if (inside !== 9) throw new DiscordRejected(`${where}: a thumbnail is only allowed as a section's accessory.`); return; }
    if (component.type === 2 && inside === 9) return checkButton(component, where);
    const Builder = v2Builders[component.type as number];
    if (!Builder) throw new DiscordRejected(`${where}: component type ${String(component.type)} is not a Components V2 component.`);
    if (inside === 17 && component.type === 17) throw new DiscordRejected(`${where}: containers cannot be nested.`);
    if (component.type === 9) {
      const texts = records(component.components, `${where}.components`);
      if (!texts.length || texts.length > v2Limits.section || texts.some(entry => entry.type !== 10)) throw new DiscordRejected(`${where}: a section holds 1–${v2Limits.section} text displays.`);
      texts.forEach((entry, index) => visit(entry, `${where}.components[${index}]`, 9));
      if (!component.accessory) throw new DiscordRejected(`${where}: a section needs an accessory (a thumbnail or a button).`);
      visit(component.accessory as Json, `${where}.accessory`, 9);
    }
    if (component.type === 17) records(component.components, `${where}.components`).forEach((entry, index) => visit(entry, `${where}.components[${index}]`, 17));
    if (component.type === 13) {
      const url = (component.file as { url?: unknown } | undefined)?.url;
      if (typeof url !== 'string' || !url.startsWith('attachment://')) throw new DiscordRejected(`${where}.file: a file component only takes attachment:// urls.`);
    }
    if (component.type === 12) {
      const items = records(component.items, `${where}.items`);
      if (!items.length || items.length > v2Limits.gallery) throw new DiscordRejected(`${where}: a media gallery holds 1–${v2Limits.gallery} items, not ${items.length}.`);
    }
    // discord.js builds raw components into builders on send; this is that exact step.
    at(where, () => new Builder(component as never).toJSON());
  };
  top.forEach((component, index) => visit(component, `components[${index}]`));
  if (count > v2Limits.components) throw new DiscordRejected(`components: ${count} components; Discord allows ${v2Limits.components}.`);
  if (text > v2Limits.text) throw new DiscordRejected(`components: ${text} characters of text; Discord allows ${v2Limits.text}.`);
}

function checkRow(row: Json, where: string, ids: Set<string>): void {
  const components = records(row.components, `${where}.components`);
  if (!components.length || components.length > limits.buttons) throw new DiscordRejected(`${where}: a row holds 1–${limits.buttons} components, not ${components.length}.`);
  components.forEach((component, number) => {
    const place = `${where}.components[${number}]`;
    if (typeof component.custom_id === 'string') {
      if (ids.has(component.custom_id)) throw new DiscordRejected(`${place}: custom_id ${component.custom_id} is used twice in one message.`);
      ids.add(component.custom_id);
    }
    if (component.type === 2) checkButton(component, place);
    else if (component.type === 3) {
      if (components.length > 1) throw new DiscordRejected(`${place}: a select must be alone in its row.`);
      checkSelect(component, place);
    } else throw new DiscordRejected(`${place}: component type ${String(component.type)} is not a button or string select.`);
  });
  // discord.js turns raw rows into builders on send; this is that exact step.
  at(where, () => new ActionRowBuilder(row as never).toJSON());
}

/** A message as teapilot sends it: `content`, raw `embeds` and raw action rows, or Components V2 with `flags`. */
export function checkMessage(payload: { content?: unknown; embeds?: unknown; components?: unknown; files?: unknown[]; flags?: unknown }): void {
  if (typeof payload.flags === 'number' && payload.flags & componentsV2) return checkComponentsV2(payload);
  const content = payload.content ?? '';
  if (typeof content !== 'string') throw new DiscordRejected('content must be a string.');
  if (content.length > limits.content) throw new DiscordRejected(`content is ${content.length} characters; Discord allows ${limits.content}.`);
  checkEmbeds(payload.embeds);
  const rows = records(payload.components, 'components');
  if (!content.trim() && !records(payload.embeds, 'embeds').length && !rows.length && !payload.files?.length) throw new DiscordRejected('Cannot send an empty message.');
  if (rows.length > limits.rows) throw new DiscordRejected(`components: ${rows.length} rows; Discord allows ${limits.rows}.`);
  const ids = new Set<string>();
  rows.forEach((row, index) => {
    const where = `components[${index}]`;
    if (row.type !== 1) throw new DiscordRejected(`${where}: expected an action row (type 1), or the Components V2 flag.`);
    checkRow(row, where, ids);
  });
}

/** A form as teapilot shows it with showModal. */
export function checkModal(payload: { custom_id?: unknown; title?: unknown; components?: unknown }): void {
  const modal = new ModalBuilder();
  apply('modal', payload, { custom_id: (value: string) => modal.setCustomId(value), title: (value: string) => modal.setTitle(value) });
  const rows = records(payload.components, 'modal.components');
  if (!rows.length || rows.length > limits.modalRows) throw new DiscordRejected(`modal: a form holds 1–${limits.modalRows} rows, not ${rows.length}.`);
  const ids = new Set<string>();
  rows.forEach((row, index) => {
    const where = `modal.components[${index}]`;
    const inputs = records(row.components, `${where}.components`);
    if (row.type !== 1 || inputs.length !== 1 || inputs[0]!.type !== 4) throw new DiscordRejected(`${where}: each form row holds exactly one text input.`);
    const input = inputs[0]!;
    if (input.label === undefined) throw new DiscordRejected(`${where}: a text input needs a label.`);
    const built = new TextInputBuilder();
    apply(where, input, {
      custom_id: (value: string) => built.setCustomId(value), label: (value: string) => built.setLabel(value), style: (value: number) => built.setStyle(value),
      min_length: (value: number) => built.setMinLength(value), max_length: (value: number) => built.setMaxLength(value), required: (value: boolean) => built.setRequired(value),
      placeholder: (value: string) => built.setPlaceholder(value), value: (value: string) => built.setValue(value),
    });
    at(where, () => built.toJSON());
    if (typeof input.min_length === 'number' && typeof input.max_length === 'number' && input.min_length > input.max_length) throw new DiscordRejected(`${where}: min_length is above max_length.`);
    if (ids.has(input.custom_id as string)) throw new DiscordRejected(`${where}: field id ${String(input.custom_id)} is used twice.`);
    ids.add(input.custom_id as string);
  });
  // discord.js builds raw modals with ModalBuilder before sending; this is that exact step.
  at('modal', () => new ModalBuilder(payload as never).toJSON());
}

/** Discord's upload limit for bots, and how many files one message may carry. */
const upload = { bytes: 10 * 1024 * 1024, files: 10 };
/** Attachments: within Discord's limits, and every attachment:// an embed or component shows is one the message carries. */
export function checkFiles(payload: { embeds?: unknown; components?: unknown; files?: Array<{ name: string; data: Buffer }> }): void {
  const files = payload.files ?? [];
  if (files.length > upload.files) throw new DiscordRejected(`files: ${files.length} attachments; Discord allows ${upload.files}.`);
  for (const file of files) if (file.data.length > upload.bytes) throw new DiscordRejected(`files: ${file.name} is ${(file.data.length / 1024 / 1024).toFixed(1)} MB; bots may upload 10 MB (Request entity too large).`);
  records(payload.embeds, 'embeds').forEach((embed, index) => {
    for (const key of ['image', 'thumbnail'] as const) {
      const url = (embed[key] as { url?: unknown } | undefined)?.url;
      if (typeof url === 'string' && url.startsWith('attachment://') && !files.some(file => file.name === url.slice('attachment://'.length))) {
        throw new DiscordRejected(`embeds[${index}].${key}: ${url} is not attached to the message, so Discord shows no image.`);
      }
    }
  });
  for (const name of componentAttachments(payload.components)) {
    if (!files.some(file => file.name === name)) throw new DiscordRejected(`components: attachment://${name} is not attached to the message, so Discord shows nothing there.`);
  }
}
