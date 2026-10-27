### LOKY AI Next — production image
##
## No build step: the frontend is plain HTML/CSS/JS and the two browser
## libraries (marked + DOMPurify) are copied out of node_modules into
## public/vendor at image build time.
##
## Note on script order: `postinstall` runs scripts/vendor-assets.js, but the
## source is not in the image yet at `npm install` time. So installs skip
## lifecycle scripts and the vendoring step is run explicitly after COPY.

FROM node:20-alpine

WORKDIR /app

# Ensure production mode for Express and any dependency that checks it.
ENV NODE_ENV=production

# Dependencies first, so this layer is cached when only app code changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Application code (node_modules, .env, tests excluded via .dockerignore).
COPY . .

# Vendor marked + DOMPurify into public/vendor now that scripts/ exists.
RUN node scripts/vendor-assets.js && test -s public/vendor/marked.esm.js

# The deployed container port. server/config.js reads process.env.PORT.
ENV PORT=80
ENV HOST=0.0.0.0
EXPOSE 80

# Fail the build early if the server module cannot be parsed.
RUN node --check server/index.js

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||80)+'/api/health').then(r=>process.exit(r.ok||r.status===503?0:1)).catch(()=>process.exit(1))"

# server/index.js binds HOST (0.0.0.0) on PORT — required for the platform proxy.
CMD ["node", "server/index.js"]
