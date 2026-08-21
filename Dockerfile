FROM --platform=linux/amd64 node:22-alpine

ENV NODE_ENV=production \
    STARTUP_DELAY_MS=3000 \
    WORK_DELAY_MS=500

WORKDIR /app

COPY --chown=node:node container/server.mjs ./server.mjs

USER node

EXPOSE 8080

CMD ["node", "server.mjs"]
