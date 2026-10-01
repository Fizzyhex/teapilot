/**
 * Markdown to Discord messages. Discord's message markdown has no tables, dividers or inline images; this lays an
 * answer out so they show anyway: tables as embed fields with a "view source" button, and dividers, images and files
 * as Components V2. Everything is plain Discord API JSON, so it works with discord.js or the REST API alike.
 */
export { chunk, fence, fences, MESSAGE_LIMIT } from './chunk.js';
export { cells, parse, type Block, type MediaRef, type Table } from './parse.js';
export { codeTable, defaultViewSourcePrefix, markdownTable, tableEmbed, viewSource, viewSourceRow, type Embed, type EmbedField, type TableLayout } from './table.js';
export { componentLimits, IS_COMPONENTS_V2, layout, type Component, type LayoutOptions, type Message, type Resolved, type Upload } from './layout.js';
