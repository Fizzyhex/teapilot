// What Discord would refuse, checked offline: the checks discord.js runs when it sends raw JSON, its
// builders' per-field rules, and the API limits the builders leave to the server.
import { ActionRowBuilder, ButtonBuilder, EmbedBuilder, embedLength, ModalBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, TextInputBuilder, type APIEmbed } from 'discord.js';

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

/** A message as teapilot sends it: `content`, raw `embeds` and raw action rows. */
export function checkMessage(payload: { content?: unknown; embeds?: unknown; components?: unknown }): void {
  const content = payload.content ?? '';
  if (typeof content !== 'string') throw new DiscordRejected('content must be a string.');
  if (content.length > limits.content) throw new DiscordRejected(`content is ${content.length} characters; Discord allows ${limits.content}.`);
  checkEmbeds(payload.embeds);
  const rows = records(payload.components, 'components');
  if (!content.trim() && !records(payload.embeds, 'embeds').length && !rows.length) throw new DiscordRejected('Cannot send an empty message.');
  if (rows.length > limits.rows) throw new DiscordRejected(`components: ${rows.length} rows; Discord allows ${limits.rows}.`);
  const ids = new Set<string>();
  rows.forEach((row, index) => {
    const where = `components[${index}]`;
    if (row.type !== 1) throw new DiscordRejected(`${where}: expected an action row (type 1).`);
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
