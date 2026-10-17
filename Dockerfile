FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV npm_config_nimsdkurl="https://yx-web-nosdn.netease.im/package/1754647144528/nim-linux-x64-10-9-40-4284-build-3172678.tar.gz?download=nim-linux-x64-10-9-40-4284-build-3172678.tar.gz"
COPY package*.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates libstdc++6 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chmod 700 /data
EXPOSE 8787
CMD ["node", "dist/src/server.js"]
