FROM node:22.19.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates xvfb libasound2 libatk1.0-0 libatk-bridge2.0-0 libnss3 libgtk-3-0 libgbm1 libxss1 libx11-xcb1 xauth && rm -rf /var/lib/apt/lists/*
WORKDIR /work
COPY package.json package-lock.json ./
RUN npm ci
COPY extensions/vscode/package.json extensions/vscode/package-lock.json ./extensions/vscode/
RUN npm ci --prefix extensions/vscode
COPY . .
RUN npm run check && npm run typecheck --prefix extensions/vscode && npm run package --prefix extensions/vscode
CMD ["xvfb-run", "-a", "npm", "test", "--prefix", "extensions/vscode"]
