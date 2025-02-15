FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
COPY tsconfig.json ./
RUN npm install

COPY src ./src

RUN npx tsc --project ./tsconfig.json

EXPOSE 3000
CMD ["npm", "start"] 