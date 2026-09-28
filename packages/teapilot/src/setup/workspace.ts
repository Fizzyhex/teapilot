import type { Config } from '../config.js';
import { configureWorkspace, defaultWorkspaceIO, type WorkspaceIO } from '../workspace/configure.js';
import { defaultWorkspaceSettings } from '../workspace/sandbox.js';
import type { SetupUI } from './terminal.js';

/**
 * Whether conversations get sandboxed workspaces, with the sandbox and teapilot's own tools installed on request.
 * Installs happen here, like agent-browser's; only WORKSPACE_SANDBOX waits for Save.
 */
export async function configureWorkspaceStep(config: Config, env: Record<string, string>, ui: SetupUI, signal: AbortSignal, io: WorkspaceIO = defaultWorkspaceIO): Promise<string> {
  const current = env.WORKSPACE_SANDBOX === 'off' ? 'off' : 'on';
  ui.log('Give teapilot access to workspaces for writing python utils. Useful for image manip tasks, file conversions, PDF parsing, etc.');
  const choice = await ui.choose('Workspace Extras · Optional', [current === 'off' ? 'Turn on and set up' : 'Set up', `Keep current (${current})`, 'Turn off'], 0);
  if (choice === 1) return `workspaces: ${current}`;
  if (choice === 2) {
    env.WORKSPACE_SANDBOX = 'off';
    config.workspace = { ...config.workspace ?? defaultWorkspaceSettings, sandbox: 'off' };
    return 'workspaces: off';
  }
  delete env.WORKSPACE_SANDBOX;
  config.workspace = { ...config.workspace ?? defaultWorkspaceSettings, sandbox: 'auto' };
  const status = await configureWorkspace(config, ui, signal, io);
  return status.available ? `workspaces: on (${status.tools.length ? status.tools.map(tool => tool.name).join(', ') : 'no tools found'})` : 'workspaces: on (sandbox not ready)';
}
