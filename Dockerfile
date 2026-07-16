# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS builder

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    libcairo2-dev \
    libgif-dev \
    libjpeg62-turbo-dev \
    libpango1.0-dev \
    librsvg2-dev \
    pkg-config \
    python3 \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global pnpm@10.15.0

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY config.example.json ./config.json
COPY src ./src

RUN pnpm build \
  && pnpm prune --prod

FROM node:24-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    fonts-noto-cjk \
    libcairo2 \
    libgif7 \
    libjpeg62-turbo \
    libpango-1.0-0 \
    librsvg2-2 \
    tzdata \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    DATA_PATH=/app/data/data.db \
    TZ=Asia/Shanghai

WORKDIR /app

COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --chown=node:node fonts ./fonts
COPY --chown=node:node config.example.json ./config.json

RUN mkdir -p /app/data && chown node:node /app/data

USER node

VOLUME ["/app/data"]

CMD ["node", "dist/index.js"]
