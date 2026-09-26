import { openRoom } from '../../src/store.js';

const [dir, author, count] = process.argv.slice(2);
const room = await openRoom({ dir: dir! });
for (let i = 0; i < Number(count); i++) await room.post({ channel: 'offtopic', author: author!, text: `${author} ${i}` });
