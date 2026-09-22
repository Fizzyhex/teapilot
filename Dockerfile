FROM node:22.19.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig*.json vitest.config.ts ./
COPY src ./src
COPY config ./config
COPY tests ./tests
RUN npm run check && node dist/cli.js --help
RUN mkdir -p /home/node/.teapilot && chown node:node /home/node/.teapilot
USER node
ENV TEAPILOT_STATE_DIR=/home/node/.teapilot
ENTRYPOINT ["node", "/app/dist/cli.js", "--config-dir", "/app"]
CMD ["--help"]
