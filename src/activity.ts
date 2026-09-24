/** Optional, local presentation hooks. Never serialized into the service protocol. */
export interface Activity { kind: 'waiting' | 'reasoning' | 'composing'; label: string }
export type ActivitySink = (activity: Activity | undefined) => void;
export interface ActivityUI {
  activity?(activity: Activity): () => void;
  suspend?(): () => void;
}

export async function during<T>(ui: ActivityUI, label: string, operation: () => Promise<T>): Promise<T> {
  const end = ui.activity?.({ kind: 'waiting', label });
  try { return await operation(); } finally { end?.(); }
}

export async function terminalHandoff<T>(ui: ActivityUI, operation: () => Promise<T>): Promise<T> {
  const resume = ui.suspend?.();
  try { return await operation(); } finally { resume?.(); }
}
