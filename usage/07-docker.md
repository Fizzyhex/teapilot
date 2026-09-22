# Docker

Build the image and check the CLI (the build also runs checks):

```sh
docker build -t teapilot .
docker run --rm teapilot --help
```

To use it interactively, add `-it --env-file .env`, mount your repository at `/workspace`, mount a persistent volume at `/home/node/.teapilot`, and pass `--cwd /workspace "your request"`. Configure model URLs reachable **from the container**; localhost inside it is not your host model server. Mount personal config files read-only at `/app/config/models.json` and `/app/config/policy.json` when using them. The image runs as the `node` user; the workspace mount must be writable by that user.

[Back to README](../README.md)
