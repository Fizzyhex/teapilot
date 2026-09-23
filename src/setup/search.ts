import { during } from '../activity.js';
import type { Config } from '../config.js';
import { searchQuery } from '../search.js';
import type { SetupUI } from './terminal.js';
import { ManagedSearch } from './searxng.js';

export async function configureSearch(config: Config, env: Record<string, string>, directory: string, ui: SetupUI, signal: AbortSignal): Promise<string> {
  const choice = await ui.choose('Web search · Optional', ['Set up local search using Docker', 'Connect an existing SearXNG service', config.searchUrl ? 'Keep current search settings' : 'Skip for now', 'Disable web search'], 2);
  if (choice === 2) return config.searchUrl ? 'Unchanged · not tested' : 'Disabled';
  if (choice === 3) {
    config.searchUrl = undefined; delete env.SEARCH_BASE_URL;
    config.policy.permissions = config.policy.permissions.filter(value => value !== 'web.search');
    ui.log('Search disabled. Any managed container can be stopped with teapilot search stop.');
    return 'Disabled';
  }
  ui.log('Search queries go to external search engines, including the connectivity test. Requests still require --web. Service costs are outside inference accounting.');
  let base: string;
  if (choice === 0) {
    const service = new ManagedSearch(directory, signal);
    try { await during(ui, 'Checking Docker...', () => service.available()); }
    catch (error) {
      signal.throwIfAborted();
      ui.log(`Skipped local search: ${error instanceof Error ? error.message : 'Docker is unavailable.'}`);
      ui.log('Install/start Docker with Linux containers: https://docs.docker.com/get-started/get-docker/ · Then rerun setup.');
      return 'Unchanged · local setup skipped';
    }
    if (!await ui.confirm('Download/start SearXNG as a background service, available only on this computer, and send a test query?')) return 'Unchanged · setup declined';
    try { base = await during(ui, 'Starting local search...', () => service.start(ui.log)); }
    catch (error) {
      signal.throwIfAborted();
      ui.log(`Search setup failed: ${error instanceof Error ? error.message : 'Check Docker.'} You can continue saving the model settings.`);
      ui.log(`Manage the service: teapilot search status|stop|remove --config-dir "${directory}"`);
      return 'Unchanged · local setup failed';
    }
  } else {
    for (;;) {
      base = await ui.input('SearXNG base URL (Enter to skip)');
      if (!base) { ui.log('Skipped search configuration.'); return config.searchUrl ? 'Unchanged · not tested' : 'Disabled'; }
      try {
        const url = new URL(base);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
        break;
      } catch { ui.log('Invalid URL. Enter an HTTP(S) address without credentials, query or fragment, for example http://localhost:8888, or press Enter to skip.'); }
    }
    if (!await ui.confirm('Allow web.search in this profile and send a connectivity test now?')) return 'Unchanged · test declined';
  }
  for (;;) {
    try {
      await during(ui, 'Checking search connectivity...', () => searchQuery(base, 'teapilot connectivity check', signal));
      config.searchUrl = base; env.SEARCH_BASE_URL = base;
      if (!config.policy.permissions.includes('web.search')) config.policy.permissions.push('web.search');
      ui.log('Search: PASS (SearXNG JSON response).');
      return `Verified · ${base}`;
    } catch (error) {
      signal.throwIfAborted();
      ui.log(`Search: FAIL. ${error instanceof Error ? error.message : 'Check the search service.'}`);
      if (!await ui.confirm('Retry the connectivity test?')) {
        ui.log('Search settings unchanged. Model settings can still be saved.');
        return 'Unchanged · connection failed';
      }
    }
  }
}
