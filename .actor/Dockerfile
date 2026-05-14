FROM apify/actor-node:24 AS builder

RUN corepack enable && corepack prepare pnpm@11.1.2 --activate

# package.json and pnpm-lock.yaml to speed up the build using
# Docker layer cache.
COPY package.json pnpm-lock.yaml* ./

# Install all dependencies including dev.
RUN pnpm install --frozen-lockfile

# Next, copy the source files using the user set in the base image.
COPY . ./

# Build the project.
RUN pnpm run build

# Create final image
FROM apify/actor-node:24

# Enable pnpm via corepack.
RUN corepack enable && corepack prepare pnpm@11.1.2 --activate

# Copy just package.json and pnpm-lock.yaml to speed up the build using
# Docker layer cache.
COPY package.json pnpm-lock.yaml* ./

# Install production dependencies only.
RUN pnpm install --prod --frozen-lockfile

# Copy built JS files from builder image
COPY --from=builder /usr/src/app/dist ./dist

# Install Mongo Atlas CLI from deb file
RUN apk add curl
RUN curl https://fastdl.mongodb.org/mongocli/mongodb-atlas-cli_1.30.0_linux_x86_64.deb -o atlas-cli.deb
RUN apk add dpkg
RUN dpkg --add-architecture amd64
RUN dpkg -i ./atlas-cli.deb

# Next, copy the remaining files and directories with the source code.
# Since we do this after install, quick build will be really fast
# for most source file changes.
COPY . ./

# Run the image.
CMD pnpm run start:prod --silent
