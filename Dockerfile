FROM oven/bun:1.2.5-alpine

WORKDIR /app

RUN apk add --no-cache ffmpeg ca-certificates

COPY package.json bun.lock ./
RUN bun install

COPY . .
RUN bun run build

ENV NODE_ENV=production
ENV PORT=10000
EXPOSE 10000

# Bun executes TypeScript natively; avoid relying on dev-only tsx at runtime.
CMD ["bun", "run", "server.ts"]
