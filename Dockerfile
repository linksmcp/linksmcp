# Build stage: compiles TypeScript and the better-sqlite3 native module.
FROM node:20-alpine AS build
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# Runtime stage: only dist and production dependencies.
FROM node:20-alpine
LABEL org.opencontainers.image.source="https://github.com/linksmcp/linksmcp" \
      org.opencontainers.image.description="LinkedIn MCP server you run yourself" \
      org.opencontainers.image.licenses="MIT" \
      io.modelcontextprotocol.server.name="io.github.linksmcp/linksmcp"
WORKDIR /app
ENV NODE_ENV=production \
    LINKSMCP_HOME=/data
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/contract ./contract
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
ENTRYPOINT ["node", "dist/cli.js"]
