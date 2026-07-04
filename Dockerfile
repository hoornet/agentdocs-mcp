# agentdocs-mcp — stdio MCP server for AgentDocs (agentdocs.eu)
#
# Required at the repo root by the Docker MCP registry (docker/mcp-registry):
# Docker builds, signs, and publishes this as mcp/agentdocs-mcp for the
# Docker MCP catalog/gateway. Local build:
#
#   docker build -t agentdocs-mcp .
#   docker run -i --rm -e AGENTDOCS_TOKEN=<token> agentdocs-mcp

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
ENTRYPOINT ["node", "dist/index.js"]
