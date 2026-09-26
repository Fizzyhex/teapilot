FROM node:22.19.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/teachat/package.json ./packages/teachat/
COPY packages/teapilot/package.json ./packages/teapilot/
RUN npm ci
COPY packages/teachat ./packages/teachat
COPY packages/teapilot ./packages/teapilot
RUN npm run check && node packages/teapilot/dist/cli.js --help
RUN mkdir -p /home/node/.teapilot && chown node:node /home/node/.teapilot
USER node
ENV TEAPILOT_STATE_DIR=/home/node/.teapilot
ENTRYPOINT ["node", "/app/packages/teapilot/dist/cli.js", "--config-dir", "/app/packages/teapilot"]
CMD ["--help"]
