FROM node:20.5-slim

WORKDIR /app
ENV TZ=America/Sao_Paulo

RUN apt update -y
RUN apt install telnet -y
RUN apt install vim -y

COPY package.json ./
RUN npm install

RUN npm install -g nodemon
RUN npm install -g pm2

COPY . .
CMD ["pm2-runtime", "start", "ecosystem.config.js"]
