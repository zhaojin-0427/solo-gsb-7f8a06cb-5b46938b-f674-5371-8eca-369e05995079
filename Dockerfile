# syntax=docker/dockerfile:1

# ---- 构建阶段：安装依赖并把 Ajv 8 打包为浏览器端 IIFE ----
FROM node:22-alpine AS build

WORKDIR /app

# 先拷依赖清单，尽量利用构建缓存
COPY package.json package-lock.json* ./
RUN npm ci

# esbuild 打包入口与源码
COPY vendor-src ./vendor-src
COPY public ./public
COPY lib ./lib
RUN npm run build:vendor

# ---- 运行阶段：仅保留生产依赖 ----
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY lib ./lib
COPY public ./public
# 浏览器端使用的 Ajv 8（Draft 2020-12）本地打包产物
COPY --from=build /app/vendor ./vendor

ENV PORT=8080
EXPOSE 8080

USER node
CMD ["node", "server.js"]
