## No Esculation Error

No esculation errors can cause serious friction - haulting tasks entirely:

```sh
PS C:\Users\simul> teapilot code --cwd "C:\Users\simul\OneDrive\Documents\GitHub\web-pong" "Create a basic web application for a Pong game, using Javascript/html/css."
Routing with JevRouter.
Executing coder.local using teapilot-ce16d112f0-16384:latest.
Run powershell in C:\Users\simul\OneDrive\Documents\GitHub\web-pong? This can have external or destructive effects.
Get-ChildItem -Path "C:\Users\simul\OneDrive\Documents\GitHub\web-pong" -File | Select-Object Name, Extension
Approve this action? Type yes to confirm [no]: yes
Run powershell in C:\Users\simul\OneDrive\Documents\GitHub\web-pong? This can have external or destructive effects.
Get-ChildItem "C:\Users\simul\OneDrive\Documents\GitHub\web-pong" -Recurse -File | Select-Object Name, Extension | Format-Table
Approve this action? Type yes to confirm [no]: yes
Run powershell in C:\Users\simul\OneDrive\Documents\GitHub\web-pong? This can have external or destructive effects.
cd "C:\Users\simul\OneDrive\Documents\GitHub\web-pong" && dir
Approve this action? Type yes to confirm [no]: yes
Run powershell in C:\Users\simul\OneDrive\Documents\GitHub\web-pong? This can have external or destructive effects.
cd "C:\Users\simul\OneDrive\Documents\GitHub\web-pong"; dir
Approve this action? Type yes to confirm [no]: yes
Run powershell in C:\Users\simul\OneDrive\Documents\GitHub\web-pong? This can have external or destructive effects.
Get-ChildItem "C:\Users\simul\OneDrive\Documents\GitHub\web-pong" -Recurse
Approve this action? Type yes to confirm [no]: yes
Cheaper attempt failed; no affordable, available escalation model.
```

Suggested fix: \<TODO>

## Aesthetics

The CLI does not use symbols, colours or inline elements to help with present information.

A simple colour palette inspired by 'Tea', varying shades of grey, and bold text could help the user distinguish between different elements. It needs to remain elegant, non-distracting, and not hinder copy and paste. 

Paws that type on a keyboard as the agent writes tokens would be fantastic - and would make the UX feel unique.

## Markdown

Teapilot responded with:

```
I don't have information about a "Jev" integration for Teapilot. It could be:

1. **A typo** - Did you mean Jira, Jenkins, Jeedom, or another tool?
2. **A very niche/internal tool** - Not widely documented publicly
3. **Not an official integration** - Could be a third-party solution
```

Markdown formatting could be recognised, and bold/italic text could help convey formatting without hiding any characters.

## Web Search

The user ran:

```sh
teapilot --web "I'm interested in using Postgres DB and having my DB sync with a backup held on a GitHub repo. Any ideas?"

> --web requires SEARCH_BASE_URL and web.search permission
```

This is an unclear setup experince - Teapilot should ideally focus on presenting solutions, rather than purely raising problems. 