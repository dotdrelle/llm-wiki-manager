FROM node:22-slim

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY bin/ ./bin/
COPY src/ ./src/

ENV NODE_PATH=/app/node_modules

EXPOSE 7788

ENTRYPOINT ["node", "./bin/wiki-manager.js"]
