import { crc32, deflateRaw } from 'node:zlib';
import { promisify } from 'node:util';

const deflate = promisify(deflateRaw);

/** A zip archive holding one file, for sending something that is too big as it is. */
export async function zipFile(name: string, data: Buffer, modified = new Date()): Promise<Buffer> {
  const packed = await deflate(data);
  // Stored as is when deflating does not help; method 8 is deflate, 0 is stored.
  const method = packed.length < data.length ? 8 : 0;
  const body = method === 8 ? packed : data;
  const label = Buffer.from(name, 'utf8');
  const checksum = crc32(data);
  const time = (modified.getHours() << 11) | (modified.getMinutes() << 5) | (modified.getSeconds() >> 1);
  const date = (Math.max(modified.getFullYear() - 1980, 0) << 9) | ((modified.getMonth() + 1) << 5) | modified.getDate();

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  // Bit 11 marks the name as UTF-8.
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(label.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(date, 14);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(label.length, 28);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + label.length, 12);
  end.writeUInt32LE(30 + label.length + body.length, 16);

  return Buffer.concat([local, label, body, central, label, end]);
}
