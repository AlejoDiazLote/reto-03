FROM oven/bun:1-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY agent ./agent
COPY src ./src
COPY web ./web
COPY fixtures ./fixtures
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
USER bun
CMD ["bun", "src/server.ts"]
