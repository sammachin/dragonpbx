FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --production

COPY . .

EXPOSE 2999

CMD ["node", "app.js"]
