FROM node:20-alpine
WORKDIR /app

# deps
COPY package*.json ./
RUN npm ci || npm i

# конфиги и исходники
COPY tsconfig.json ./
COPY .env ./
COPY src ./src

# гарантируем нужные пакеты
RUN npm i @aws-sdk/client-s3 dayjs pg express && \
    npm i -D typescript @types/node @types/express @types/pg

# сборка
RUN npm run build

EXPOSE 8081
CMD ["npm","start"]
