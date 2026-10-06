# ---------- 构建阶段（含 devDependencies，可跑测试） ----------
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json jest.config.js ./
COPY src ./src
COPY test ./test
RUN npm run build

# ---------- 生产镜像 ----------
FROM node:20-alpine AS production
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/server.js"]
