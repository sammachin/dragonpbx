FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache git

RUN git clone https://github.com/sammachin/dragonpbx.git .

RUN npm ci --production

EXPOSE 2999

CMD ["node", "app.js"]
