import { command } from './ollama.js';

export interface NvidiaGpu {
  name: string;
  memoryMiB: number;
}

export interface HardwareReport {
  platform: NodeJS.Platform;
  nvidia: NvidiaGpu[];
  optimizedNvidia: boolean;
  reason?: string;
}

export interface HardwareDependencies {
  platform: NodeJS.Platform;
  run: typeof command;
}

export const optimizedNvidiaMinimumMiB = 22 * 1024;

export async function inspectHardware(
  signal: AbortSignal,
  deps: HardwareDependencies = { platform: process.platform, run: command },
): Promise<HardwareReport> {
  if (deps.platform !== 'win32') {
    return { platform: deps.platform, nvidia: [], optimizedNvidia: false, reason: 'Optimized NVIDIA setup is currently supported on Windows.' };
  }
  try {
    const text = await deps.run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], AbortSignal.any([signal, AbortSignal.timeout(5000)]));
    const nvidia = text.split(/\r?\n/).filter(Boolean).flatMap(line => {
      const match = line.match(/^(.+),\s*(\d+(?:\.\d+)?)\s*$/);
      if (!match) return [];
      return [{ name: match[1]!.trim(), memoryMiB: Number(match[2]) }];
    }).filter(gpu => Number.isFinite(gpu.memoryMiB));
    if (!nvidia.length) return { platform: deps.platform, nvidia: [], optimizedNvidia: false, reason: 'nvidia-smi returned no usable GPU information.' };
    const largest = Math.max(...nvidia.map(gpu => gpu.memoryMiB));
    return {
      platform: deps.platform,
      nvidia,
      optimizedNvidia: largest >= optimizedNvidiaMinimumMiB,
      reason: largest >= optimizedNvidiaMinimumMiB ? undefined : 'Largest NVIDIA GPU has ' + Math.round(largest / 1024) + ' GiB VRAM; the optimized preset targets a 24 GB-class GPU.',
    };
  } catch {
    signal.throwIfAborted();
    return { platform: deps.platform, nvidia: [], optimizedNvidia: false, reason: 'nvidia-smi is unavailable or failed. Install a working NVIDIA driver to use Optimized NVIDIA.' };
  }
}
