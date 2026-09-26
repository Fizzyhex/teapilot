import { spawn } from 'node:child_process';

/** Only what the suitability decision needs. index is nvidia-smi's (PCI bus) order. */
export interface NvidiaGpu { index: number; name: string; memoryMiB: number; driver: string }

/** What nvidia-smi reported. Every outcome is a value: nothing here throws for a missing GPU. */
export type NvidiaDetection =
  | { kind: 'command-missing' }
  | { kind: 'no-gpu'; detail?: string }
  | { kind: 'malformed'; detail: string }
  | { kind: 'found'; gpus: NvidiaGpu[] };

/** The process boundary: resolves with the exit code and output, rejects only when the program cannot start. */
export type ProcessRun = (executable: string, args: string[], signal: AbortSignal, options?: { cwd?: string; env?: NodeJS.ProcessEnv }) => Promise<{ code: number | null; stdout: string }>;

export const runProcess: ProcessRun = (executable, args, signal, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(executable, args, { shell: false, windowsHide: true, signal, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  let stdout = '';
  child.stdout.on('data', part => { stdout = (stdout + String(part)).slice(-16000); });
  child.stderr.on('data', part => { stdout = (stdout + String(part)).slice(-16000); });
  child.on('error', reject);
  child.on('close', code => resolve({ code, stdout }));
});

export const nvidiaQuery = ['--query-gpu=index,name,memory.total,driver_version', '--format=csv,noheader,nounits'];

export async function detectNvidia(signal: AbortSignal, run: ProcessRun = runProcess): Promise<NvidiaDetection> {
  let result: { code: number | null; stdout: string };
  try { result = await run('nvidia-smi', nvidiaQuery, AbortSignal.any([signal, AbortSignal.timeout(10000)])); }
  catch (error) {
    signal.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'command-missing' };
    return { kind: 'no-gpu', detail: error instanceof Error ? error.message : String(error) };
  }
  const output = result.stdout.trim();
  // nvidia-smi exits non-zero when no device is present or the driver is not loaded.
  if (result.code !== 0) return { kind: 'no-gpu', detail: output.split(/\r?\n/)[0]?.slice(0, 200) || `nvidia-smi exited with ${result.code}` };
  if (!output || /no devices were found/i.test(output)) return { kind: 'no-gpu' };
  const gpus: NvidiaGpu[] = [];
  for (const line of output.split(/\r?\n/).filter(line => line.trim())) {
    const fields = line.split(',').map(field => field.trim());
    const [index, memory, driver] = [Number(fields[0]), Number(fields[fields.length - 2]), fields[fields.length - 1]!];
    // A name may itself contain commas; index is first and memory, driver are last.
    const name = fields.slice(1, -2).join(', ');
    if (fields.length < 4 || !Number.isInteger(index) || !Number.isFinite(memory) || memory <= 0 || !name || !/^\d+(\.\d+)+$/.test(driver)) {
      return { kind: 'malformed', detail: line.slice(0, 200) };
    }
    gpus.push({ index, name, memoryMiB: memory, driver });
  }
  return { kind: 'found', gpus };
}

export interface NvidiaRequirement { minimumMemoryMiB: number; minimumDriver: string }

export type NvidiaAssessment =
  | { suitable: true; gpu: NvidiaGpu; summary: string; notes: string[] }
  | { suitable: false; reason: string; gpu?: NvidiaGpu };

/** Compare dotted driver versions numerically: 610.60 > 570.65. */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

const gib = (mib: number) => `${(mib / 1024).toFixed(0)} GB`;
export const describeGpu = (gpu: NvidiaGpu) => `${gpu.name} (GPU ${gpu.index}, ${gib(gpu.memoryMiB)}, driver ${gpu.driver})`;

/**
 * Decide whether a detected machine can run a deployment, picking one GPU
 * explicitly: the qualifying GPU with the most memory, lowest index on a tie.
 */
export function assessNvidia(detection: NvidiaDetection, requirement: NvidiaRequirement): NvidiaAssessment {
  switch (detection.kind) {
    case 'command-missing': return { suitable: false, reason: 'nvidia-smi was not found, so no NVIDIA driver is installed. Install the NVIDIA driver to use this option.' };
    case 'no-gpu': return { suitable: false, reason: `No NVIDIA GPU was found${detection.detail ? ` (${detection.detail})` : ''}.` };
    case 'malformed': return { suitable: false, reason: `nvidia-smi returned output TeaPilot could not read: ${detection.detail}` };
  }
  const gpus = [...detection.gpus].sort((a, b) => b.memoryMiB - a.memoryMiB || a.index - b.index);
  const enough = gpus.filter(gpu => gpu.memoryMiB >= requirement.minimumMemoryMiB);
  const largest = gpus[0];
  if (!largest) return { suitable: false, reason: 'No NVIDIA GPU was found.' };
  if (!enough.length) return { suitable: false, gpu: largest, reason: `${describeGpu(largest)} has less than the ${gib(requirement.minimumMemoryMiB)} of GPU memory this needs.` };
  const gpu = enough.find(item => compareVersions(item.driver, requirement.minimumDriver) >= 0);
  if (!gpu) return { suitable: false, gpu: enough[0], reason: `${describeGpu(enough[0]!)} needs NVIDIA driver ${requirement.minimumDriver} or newer. Update the driver to use this option.` };
  const notes = detection.gpus.length > 1 ? [`${detection.gpus.length} NVIDIA GPUs found; using GPU ${gpu.index}, ${gpu.name}.`] : [];
  return { suitable: true, gpu, summary: describeGpu(gpu), notes };
}
