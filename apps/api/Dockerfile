FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json ./
COPY apps/api/package.json ./apps/api/
COPY db/package.json ./db/

RUN npm install

COPY apps/api ./apps/api
COPY db ./db

RUN npm --workspace=apps/api run build

FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

COPY package.json ./
COPY apps/api/package.json ./apps/api/
COPY db/package.json ./db/

RUN npm install --omit=dev

COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/db ./db

EXPOSE 4000

CMD ["node", "apps/api/dist/index.js"]

