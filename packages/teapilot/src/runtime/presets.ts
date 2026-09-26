import type { PhysicalModel } from '../config.js';

/**
 * Known-good deployments. A preset records what to install and load and the
 * suggested context; it never bypasses live verification, which still decides
 * what the saved model may do.
 */
interface PresetBase {
  label: string;
  role: PhysicalModel;
  /** Suggested context tokens. */
  context: number;
  /** Approximate total download, in bytes. */
  bytes: number;
}

export interface OllamaPreset extends PresetBase {
  runtime: 'ollama';
  /** Ollama model name to pull. */
  id: string;
  /** System memory suggested, in GiB. */
  memoryGiB: number;
}

/** A Hugging Face repository at an immutable commit, and the folder it is saved as. */
export interface PinnedRepository { repository: string; revision: string; folder: string; bytes: number }

export interface TabbyPreset extends PresetBase {
  runtime: 'tabbyapi';
  id: string;
  /** The TabbyAPI commit and dependency set this preset was prepared with. */
  runtimeRevision: string;
  model: PinnedRepository;
  drafter?: PinnedRepository;
  /** Minimum GPU, checked with nvidia-smi. */
  hardware: { minimumMemoryMiB: number; minimumDriver: string; description: string };
  /** Settings for TabbyAPI's model load, needed to reproduce the deployment. */
  load: { cache_mode: string; max_batch_size: number };
  /** True only once the whole combination has passed TeaPilot's live checks on the described hardware. */
  verified: boolean;
}

export type ModelPreset = OllamaPreset | TabbyPreset;

// TabbyAPI main on 2026-09-22 ("bump exllamav3 req to v1.5.1"). Its dependency set is pinned in tabby-lock.ts.
export const tabbyRevision = 'f07131cd8fe34e449fe87cdd3a066b52b96d3cac';

export const modelPresets: ModelPreset[] = [
  { runtime: 'ollama', label: 'Fast - Qwen3.5-9B Heretic Q4_K_M', id: 'hf.co/mradermacher/Qwen3.5-9B-heretic-GGUF:Q4_K_M', bytes: 6_600_000_000, memoryGiB: 12, context: 8192, role: 'fast' },
  { runtime: 'ollama', label: 'Capable - Qwen3.8-27B Heretic ARA Q4_K_M', id: 'hf.co/mradermacher/Qwen3.8-27B-heretic-ara-GGUF:Q4_K_M', bytes: 16_900_000_000, memoryGiB: 24, context: 32768, role: 'capable' },
  // hf.co/DevJac/Qwen3.8-27B-heretic declares 65 blocks but omits the MTP block
  // (blk.64), so llama-server refuses to load it. Do not restore that preset.
  {
    runtime: 'tabbyapi', id: 'qwen3.8-27b-heretic-ara-exl3-4.0bpw-dflash2', label: 'Capable - Qwen3.8-27B Heretic ARA (4.0 bpw) with DFlash2 drafting', role: 'capable',
    context: 32768, bytes: 17_200_000_000 + 3_850_000_000, runtimeRevision: tabbyRevision,
    // The same Heretic ARA weights as the Ollama preset, and a drafter trained against them
    // (heretic-org's copy has byte-identical safetensors to trohrbaugh's, which was quantized).
    model: { repository: 'Honkware/Qwen3.8-27B-heretic-ara-exl3-4.0bpw', revision: '1d09f16a35dc3c23b9634741bf61e6c746fcce21', folder: 'Qwen3.8-27B-heretic-ara-exl3-4.0bpw', bytes: 17_200_000_000 },
    drafter: { repository: 'alphakek/Qwen3.8-27B-heretic-ara-DFlash2', revision: '75930a33a8bbbcef25e93f7c4123e5e4424c2da7', folder: 'Qwen3.8-27B-heretic-ara-DFlash2', bytes: 3_850_000_000 },
    // RTX 3090 24 GB class. CUDA 12.8 wheels need a 570.65 or newer Windows driver.
    hardware: { minimumMemoryMiB: 23 * 1024, minimumDriver: '570.65', description: '24 GB NVIDIA GPU (RTX 3090 class)' },
    // One sequence at a time: speculative decoding keeps recurrent state per sequence slot.
    load: { cache_mode: 'Q8', max_batch_size: 1 },
    // 2026-09-26, RTX 3090 (driver 610.60, ~2.4 GB used by the desktop): all live checks including
    // medium and xhigh reasoning passed; 23.0 GB in use once loaded; ~100-116 tok/s on code with the
    // drafter against ~37 tok/s without it.
    verified: true,
  },
];

export const ollamaPresets = modelPresets.filter((preset): preset is OllamaPreset => preset.runtime === 'ollama');
export const tabbyPresets = modelPresets.filter((preset): preset is TabbyPreset => preset.runtime === 'tabbyapi');
