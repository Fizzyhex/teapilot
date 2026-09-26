import { expect, it, vi } from 'vitest';
import { assessNvidia, compareVersions, detectNvidia, nvidiaQuery, type ProcessRun } from '../src/runtime/nvidia.js';

const signal = new AbortController().signal;
const requirement = { minimumMemoryMiB: 23552, minimumDriver: '570.65' };
/** nvidia-smi as the process boundary: its exit code and output, or a failure to start. */
const smi = (stdout: string, code = 0): ProcessRun => vi.fn(async () => ({ code, stdout }));
const missing: ProcessRun = async () => { throw Object.assign(new Error('spawn nvidia-smi ENOENT'), { code: 'ENOENT' }); };

it('queries only name, memory, driver and index, and reads one GPU', async () => {
  const run = smi('0, NVIDIA GeForce RTX 3090, 24576, 610.60\r\n');
  const detection = await detectNvidia(signal, run);
  expect(run).toHaveBeenCalledWith('nvidia-smi', nvidiaQuery, expect.anything());
  expect(nvidiaQuery).toEqual(['--query-gpu=index,name,memory.total,driver_version', '--format=csv,noheader,nounits']);
  expect(detection).toEqual({ kind: 'found', gpus: [{ index: 0, name: 'NVIDIA GeForce RTX 3090', memoryMiB: 24576, driver: '610.60' }] });
  expect(assessNvidia(detection, requirement)).toEqual({ suitable: true, gpu: { index: 0, name: 'NVIDIA GeForce RTX 3090', memoryMiB: 24576, driver: '610.60' }, summary: 'NVIDIA GeForce RTX 3090 (GPU 0, 24 GB, driver 610.60)', notes: [] });
});

it('reports a missing command, no GPU and unreadable output as values', async () => {
  expect(await detectNvidia(signal, missing)).toEqual({ kind: 'command-missing' });
  expect(assessNvidia({ kind: 'command-missing' }, requirement)).toMatchObject({ suitable: false, reason: expect.stringContaining('nvidia-smi was not found') });

  const none = await detectNvidia(signal, smi('No devices were found', 6));
  expect(none).toEqual({ kind: 'no-gpu', detail: 'No devices were found' });
  expect(await detectNvidia(signal, smi('NVIDIA-SMI has failed because it couldn\'t communicate with the NVIDIA driver.', 9))).toMatchObject({ kind: 'no-gpu' });
  expect(await detectNvidia(signal, smi(''))).toEqual({ kind: 'no-gpu' });
  expect(assessNvidia(none, requirement)).toMatchObject({ suitable: false, reason: expect.stringContaining('No NVIDIA GPU') });

  for (const output of ['garbage', '0, RTX 3090, lots, 610.60', '0, RTX 3090, 24576, [N/A]', 'x, RTX 3090, 24576, 610.60']) {
    const detection = await detectNvidia(signal, smi(output));
    expect(detection).toMatchObject({ kind: 'malformed' });
    expect(assessNvidia(detection, requirement)).toMatchObject({ suitable: false, reason: expect.stringContaining('could not read') });
  }
});

it('says why a GPU is not enough: memory or driver', async () => {
  const small = await detectNvidia(signal, smi('0, NVIDIA GeForce RTX 3060, 12288, 610.60'));
  expect(assessNvidia(small, requirement)).toMatchObject({ suitable: false, gpu: { index: 0 }, reason: 'NVIDIA GeForce RTX 3060 (GPU 0, 12 GB, driver 610.60) has less than the 23 GB of GPU memory this needs.' });
  const old = await detectNvidia(signal, smi('0, NVIDIA GeForce RTX 3090, 24576, 566.36'));
  expect(assessNvidia(old, requirement)).toMatchObject({ suitable: false, reason: expect.stringContaining('needs NVIDIA driver 570.65 or newer') });
  expect(compareVersions('610.60', '570.65')).toBe(1);
  expect(compareVersions('570.9', '570.65')).toBe(-1);
  expect(compareVersions('570.65', '570.65.0')).toBe(0);
});

it('picks one of several GPUs explicitly and says which', async () => {
  const detection = await detectNvidia(signal, smi([
    '0, NVIDIA GeForce RTX 3060, 12288, 610.60',
    '1, NVIDIA GeForce RTX 3090, 24576, 610.60',
    '2, NVIDIA RTX A5000, 24564, 610.60',
  ].join('\n')));
  const assessment = assessNvidia(detection, requirement);
  expect(assessment).toMatchObject({ suitable: true, gpu: { index: 1, name: 'NVIDIA GeForce RTX 3090' }, notes: ['3 NVIDIA GPUs found; using GPU 1, NVIDIA GeForce RTX 3090.'] });
  // Names containing commas still parse.
  expect(await detectNvidia(signal, smi('0, Vendor, Model X, 24576, 610.60'))).toMatchObject({ gpus: [{ name: 'Vendor, Model X' }] });
});
