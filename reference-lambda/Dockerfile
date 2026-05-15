# Multi-stage build for the reference launcher running as a long-lived
# container — Kubernetes, ECS, or a plain VM — rather than AWS Lambda.
#
# The container entry point is dist/server.js (compiled from src/server.ts):
# an HTTP adapter around the same handler.ts that the Lambda deployment uses.

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
EXPOSE 8080
USER node
CMD ["node", "dist/server.js"]
