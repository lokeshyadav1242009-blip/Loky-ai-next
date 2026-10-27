FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=80
EXPOSE 80
# IMPORTANT: your server MUST listen on 0.0.0.0 and process.env.PORT.
CMD ["npm","start"]
