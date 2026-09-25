import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { encodeMessage } from '../src/extension';

export async function run() {
  const root = process.env.TEAPILOT_TEST_ROOT!;
  const extension = vscode.extensions.getExtension('fizzyhex.teapilot');
  assert.ok(extension, 'extension registered');
  const api = await extension.activate();
  let calls = 0;
  let nativeBytes = 0;
  let nativeTools = 0;
  let authenticated = false;
  const server = createServer(async (request, response) => {
    if (request.url?.endsWith('/models')) { response.end(JSON.stringify({ data: [{ id: 'fixture' }] })); return; }
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); calls++;
    authenticated ||= request.headers.authorization === 'Bearer fixture-private-key';
    const prompt = JSON.stringify(body.messages);
    if (prompt.includes('NATIVE_AGENT_SMOKE')) { nativeBytes = Math.max(nativeBytes, Buffer.byteLength(raw)); nativeTools = Math.max(nativeTools, body.tools?.length ?? 0); }
    if (prompt.includes('SLOW_REQUEST')) { await new Promise(resolve => setTimeout(resolve, 1500)); }
    const needsWrite = prompt.includes('WRITE_FILE') && !body.messages.some((m: any) => m.role === 'tool');
    const needsLookup = prompt.includes('LOOKUP_TOOL') && !body.messages.some((m: any) => m.role === 'tool');
    const delta = needsWrite || needsLookup ? { tool_calls: [{ index: 0, id: 'test-call', type: 'function', function: { name: needsWrite ? 'write' : 'lookup', arguments: JSON.stringify(needsWrite ? { path: 'result.txt', content: 'edited by TeaPilot' } : { query: 'hello' }) } }] } : { content: 'Packaged TeaPilot response.' };
    response.setHeader('Content-Type', 'text/event-stream');
    const common = { id: 'test', object: 'chat.completion.chunk', created: 1, model: 'fixture' };
    response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: needsWrite || needsLookup ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const profile = join(root, 'profile'); await mkdir(profile);
  const runtime = join(extension.extensionPath, 'runtime', 'node_modules', 'teapilot');
  const models = JSON.parse(await readFile(join(runtime, 'config', 'models.example.json'), 'utf8'));
  const policy = JSON.parse(await readFile(join(runtime, 'config', 'policy.example.json'), 'utf8'));
  models.fast.enabled = false;
  Object.assign(models.capable, { enabled: true, id: 'fixture', provider: 'local', baseUrl: `http://127.0.0.1:${address.port}/v1`, contextTokens: 32768, maxOutputTokens: 16384, inputUsdPerMillion: 0, outputUsdPerMillion: 0, toolCalling: true });
  policy.budget.requestUsd = 0; policy.budget.dailyUsd = 0;
  await writeFile(join(profile, 'models.json'), JSON.stringify(models));
  await writeFile(join(profile, 'policy.json'), JSON.stringify(policy));
  await writeFile(join(profile, '.env'), `TEAPILOT_ROUTING_MODE=direct\nTEAPILOT_STATE_DIR=${join(root, '.state').replace(/\\/g, '/')}\n`);
  const token = new vscode.CancellationTokenSource();
  try {
    await api.client.setProfile({ directory: profile, managed: false });
    await api.client.context.secrets.store(`profile:${profile}`, JSON.stringify({ LOCAL_API_KEY: 'fixture-private-key' }));
    const commands = await vscode.commands.getCommands();
    assert.ok(commands.includes('teapilot.setup') && commands.includes('teapilot.changes'));
    assert.ok(vscode.lm.tools.some(t => t.name === 'teapilot_ask'));
    assert.ok(vscode.lm.tools.some(t => t.name === 'teapilot_code'));
    const information = await api.provider.provideLanguageModelChatInformation({ silent: true }, token.token);
    assert.deepEqual(information.map((m: any) => m.id), ['auto', 'normal', 'reasoning', 'deep']);
    const registered = await vscode.lm.selectChatModels({ vendor: 'teapilot', id: 'normal' });
    assert.equal(registered.length, 1, 'model is discoverable through VS Code registry');
    const stream: any[] = [];
    await api.provider.provideLanguageModelChatResponse(information[1], [vscode.LanguageModelChatMessage.User('LOOKUP_TOOL')], { tools: [{ name: 'lookup', description: 'lookup', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }], toolMode: vscode.LanguageModelChatToolMode.Required }, { report: (part: any) => stream.push(part) }, token.token);
    const toolCall = stream.find(part => part instanceof vscode.LanguageModelToolCallPart);
    assert.ok(toolCall);
    assert.equal(toolCall.callId, 'test-call');
    assert.equal(toolCall.name, 'lookup');
    const resumed: any[] = [];
    await api.provider.provideLanguageModelChatResponse(information[1], [vscode.LanguageModelChatMessage.User('LOOKUP_TOOL'), vscode.LanguageModelChatMessage.Assistant([toolCall]), vscode.LanguageModelChatMessage.User([new vscode.LanguageModelToolResultPart('test-call', [new vscode.LanguageModelTextPart('found')])])], { toolMode: vscode.LanguageModelChatToolMode.Auto }, { report: (part: any) => resumed.push(part) }, token.token);
    assert.ok(resumed.some(part => part.value === 'Packaged TeaPilot response.'));
    const result = await api.run({ prompt: 'WRITE_FILE', cwd: root, workload: 'coder' }, token.token);
    assert.equal(result.success, true);
    assert.equal(await readFile(join(root, 'result.txt'), 'utf8'), 'edited by TeaPilot');
    assert.ok(result.review.changes.some((c: any) => c.path === 'result.txt'));
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(join(root, 'result.txt')));
    const dirtyEdit = new vscode.WorkspaceEdit(); dirtyEdit.insert(document.uri, new vscode.Position(0, 0), 'unsaved ');
    await vscode.workspace.applyEdit(dirtyEdit); assert.equal(document.isDirty, true);
    const denied = await api.client.request('run', { prompt: 'WRITE_FILE', cwd: root, workload: 'coder' }, token.token);
    assert.equal(denied.status, 'approval_denied');
    assert.equal(await readFile(join(root, 'result.txt'), 'utf8'), 'edited by TeaPilot');
    const restore = new vscode.WorkspaceEdit(); restore.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), 'edited by TeaPilot');
    await vscode.workspace.applyEdit(restore); await document.save();
    const delegate = await vscode.lm.invokeTool('teapilot_ask', { input: { task: 'hello' }, toolInvocationToken: undefined }, token.token);
    assert.ok(delegate.content.some(part => part instanceof vscode.LanguageModelTextPart && part.value.includes('Packaged TeaPilot response')));
    // The inference lease has ended before delegated agent work begins.
    const again = await api.client.request('inference', { model: 'normal', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello again' }] }] });
    assert.equal(again.spentUsd, 0);
    const slow = api.client.request('inference', { model: 'normal', messages: [{ role: 'user', content: [{ type: 'text', text: 'SLOW_REQUEST' }] }] });
    const cancelled = new vscode.CancellationTokenSource();
    const queued = api.client.request('spending', {}, cancelled.token);
    cancelled.cancel(); await assert.rejects(queued); await slow; cancelled.dispose();
    assert.equal((await api.client.request('spending')).daily, 0);
    assert.throws(() => encodeMessage({ role: vscode.LanguageModelChatMessageRole.User, content: [{}], name: undefined }), /unsupported/);
    assert.ok(calls >= 5);
    assert.ok(authenticated, 'SecretStorage key reaches child inference without command-line credentials');
    if (process.env.TEAPILOT_NATIVE_TEST === 'true') {
      const nativeExtension = vscode.extensions.getExtension('GitHub.copilot-chat');
      assert.ok(nativeExtension, 'VS Code built-in chat extension is available');
      await nativeExtension.activate();
      models.capable.contextTokens = 262144;
      await writeFile(join(profile, 'models.json'), JSON.stringify(models));
      await api.client.setProfile({ directory: profile, managed: false });
      const native = vscode.commands.executeCommand('workbench.action.chat.open', { mode: 'agent', modelSelector: { vendor: 'teapilot', id: 'normal' }, query: 'NATIVE_AGENT_SMOKE: Say hello briefly.', blockOnResponse: true });
      let timeout: ReturnType<typeof setTimeout>;
      const nativeResult = await Promise.race([native, new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('Native Agent smoke test timed out')), 90_000); })]).finally(() => clearTimeout(timeout));
      console.log('Native Agent result:', JSON.stringify(nativeResult));
      assert.ok(nativeBytes > 0, 'native Agent reached TeaPilot model provider');
      console.log(`Native Agent request: ${nativeBytes} bytes, ${nativeTools} tools.`);
    }
    console.log('TeaPilot extension integration: provider continuation, coding review, delegation, queue cancellation and spending passed.');
  } finally {
    api.client.dispose(); token.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
