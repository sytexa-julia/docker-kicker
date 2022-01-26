FROM node:16-alpine AS build

WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 41331

FROM node:16-alpine
COPY --from=build /usr/src/app /

CMD ["node", "app.js"]
