# 构建阶段：安装全部依赖并编译 TypeScript
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --omit=optional

# 运行阶段：仅生产依赖 + 编译产物 + SQL schema
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY sql ./sql
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s \
  CMD wget -qO- http://127.0.0.1:3000/health >/dev/null 2>&1 || exit 1
CMD ["node", "dist/server.js"]
