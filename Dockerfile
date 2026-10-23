# syntax=docker/dockerfile:1
# Многостадийная сборка: TS-сервер (tsc) + Mini App (vite) → лёгкий рантайм (спека pilot-deploy).

FROM node:22-slim AS build
WORKDIR /app

# Зависимости отдельным слоем — кэшируются, пока не меняется package*.json.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY app ./app
RUN npm run build

# tsc копирует только .ts → .js. Всё остальное из src (миграции .sql, переводы i18n/*.json)
# код читает рядом с собой — переносим в dist/src с сохранением путей.
RUN cd src && find . -type f ! -name '*.ts' -exec cp --parents {} ../dist/src/ \;

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Только прод-зависимости в рантайм-образе. sharp берёт готовые бинарники linux-x64 (glibc) из
# optional-зависимостей @img/* — их не отключать (--omit=optional).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Каталог изображений из рабочих групп (том taskano-media, спека group-intake). Создаётся с владельцем
# node: пустой именованный том при первом подключении наследует владельца каталога из образа.
RUN mkdir -p /data/media && chown node:node /data/media

# node:22-slim уже содержит непривилегированного пользователя `node`.
USER node

CMD ["node", "dist/src/main.js"]
