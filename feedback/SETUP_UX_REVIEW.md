# Machine setup UX review — 23 September 2026

## Result

CLI setup is complete on Windows. Node 24.14.1, npm, Git, and the global `teapilot` command were already installed. Ollama 0.34.3 and Qwen 3.5 4B were already available; no runtime or model download was necessary. The machine has about 64 GiB RAM and an RTX 3090 with 24 GiB VRAM.

The personal profile at `~/.teapilot/config` and the ignored checkout configuration now use the verified Ollama model alias with 16,384 context tokens. Jev handles hosted routing with the supplied credential. Economy and strong execution remain disabled. Limits are $1/request and $5/UTC day. Active credential files have Windows ACLs restricted to the current user.

Verified:

- Setup's streamed-answer, tool-continuation, and exact disposable-file-edit checks all passed.
- A real `teapilot ask` request successfully routed through Jev and answered through Ollama. Accounted cost: $0.01; this is the application's accounting, not a provider billing reconciliation.
- Basic diagnostics passed both in the checkout and from the user home directory.
- The source build passed and the existing global command points to this checkout.

VS Code extension work was stopped at the user's request. No extension was installed.

## Friction observed

| Priority | Observation | Suggested improvement |
| --- | --- | --- |
| High | The checkout's old `.env` selected an unreachable port 8080 endpoint even though Ollama and a suitable model were running on port 11434. | Detect Ollama during first run and offer to reuse its installed models; diagnose the configured endpoint alongside the detected runtime. |
| High | A personal setup can succeed while subsequent commands in this checkout still select its stale configuration. The quick start also saves into the checkout, whereas the setup command defaults to the personal profile. | Show the selected configuration path in setup, doctor, and failures. Warn when the launch directory shadows the profile just saved, and offer to align them. |
| High | Providing a Jev key does not configure an execution model. The wizard configures execution but always selects direct routing and does not offer Jev configuration. | Explain routing versus execution early; offer an optional Jev key step, retain the user's routing choice, and verify routing separately. |
| Medium | An incomplete personal profile contained a model-generation file but no active `.env`; users get no explicit recovery explanation. | Detect incomplete generations, explain that setup was interrupted, and reuse already installed models during recovery. |
| Medium | Basic doctor says inference has not been tested even immediately after successful live setup, and does not test the routing key. | Clearly label this as a metadata-only check; optionally show the latest live verification timestamp and distinguish routing readiness from execution readiness. |
| Low | Successful Windows setup prints a POSIX-style `/path/to/project` example. | Print a platform-appropriate example or the current project path. |

The execution environment's interactive terminal bridge failed before launching the wizard. Setup was therefore run through the same setup implementation with an adapter selecting the existing local model. This validates the setup logic and its live checks, but does not establish the quality of keyboard navigation, hidden input, or cancellation in a normal interactive terminal.

## Everyday use

```powershell
teapilot ask "Explain dependency injection"
teapilot code --cwd "C:\path\to\project" "Describe this project"
teapilot doctor
```

The global command currently uses this source checkout, so moving or removing the checkout will break it. No application source changes were made for this setup; the UX improvements above remain recommendations.
