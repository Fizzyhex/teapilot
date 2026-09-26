import { during } from '../activity.js';
import type { Config } from '../config.js';
import type { SetupUI } from '../setup/terminal.js';
import { managedRuntimes, type Runtimes } from './index.js';
import type { RuntimeDriver, RuntimeInspection } from './types.js';

const normalise = (url: string) => url.replace(/\/$/, '');

/**
 * teapilot runtime status|start|stop, for the managed runtimes that serve the
 * configured models. Starting and stopping happen here, never on the way to a request.
 */
export async function manageRuntimes(action: string, config: Config, ui: SetupUI, signal: AbortSignal, runtimes: Runtimes = managedRuntimes()): Promise<boolean> {
  if (!['status', 'start', 'stop'].includes(action)) throw new Error('Use teapilot runtime status|start|stop.');
  const urls = new Set(Object.values(config.models).filter(model => model.enabled).map(model => normalise(model.baseUrl)));
  const serving: Array<{ driver: RuntimeDriver; state: RuntimeInspection }> = [];
  for (const driver of Object.values(runtimes)) {
    if (!driver) continue;
    const state: RuntimeInspection = await during(ui, `Checking ${driver.label}...`, () => driver.inspect(signal));
    if (state.baseUrl && urls.has(normalise(state.baseUrl))) serving.push({ driver, state });
  }
  if (!serving.length) {
    ui.log('No configured model runs on a runtime TeaPilot manages. Existing endpoints are started and stopped by whoever runs them.');
    return action === 'status';
  }
  let ok = true;
  for (const { driver, state } of serving) {
    if (action === 'status') {
      ui.log(`${driver.label}: ${state.ready ? 'running' : 'not running'}${state.version ? ` (${state.version})` : ''}${state.detail ? `; ${state.detail}` : ''}`);
      ok &&= state.ready;
    } else if (action === 'start') {
      await (driver.start ?? driver.ensure).call(driver, { ui, signal });
    } else if (driver.stop) {
      await during(ui, `Stopping ${driver.label}...`, () => driver.stop!(signal));
      ui.log(`${driver.label} stopped. Start it again with teapilot runtime start.`);
    } else ui.log(`${driver.label} manages its own service; stop it from there.`);
  }
  return ok;
}
