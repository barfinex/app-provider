# Use a lightweight Node.js base image
FROM node:18.17.1-alpine3.18 AS development

# Install necessary packages for time synchronization
# RUN apk add --no-cache tzdata openntpd

# Set the timezone to Europe/Moscow
# ENV TZ=Europe/Moscow
# RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone


# Add 8 seconds to the system time
# RUN CURRENT_TIME=$(date +%s) && \
#     NEW_TIME=$(($CURRENT_TIME + 8)) && \
#     date -s "@$NEW_TIME"


# Start the NTP client for time synchronization (optional if precise time is critical)
# RUN ntpd -d -n -p pool.ntp.org

# Set the working directory
WORKDIR /usr/src/app

# Copy only the root package.json and yarn.lock
COPY package.json yarn.lock ./


# Copy only the "provider" folder and essential config files
COPY apps/provider ./apps/provider
COPY libs ./libs
COPY nest-cli.json .
COPY tsconfig.json .
COPY tsconfig.build.json .
COPY config.json ./config.json
COPY config.advisor.json ./config.advisor.json
COPY config.detector.json ./config.detector.json
COPY config.inspector.json ./config.inspector.json
COPY config.provider.json ./config.provider.json

# Install root dependencies
RUN yarn install --frozen-lockfile

RUN yarn build:provider

CMD [ "yarn", "start:provider:prod" ]

# Install dependencies specific to the "provider" app
# WORKDIR /usr/src/app/apps/provider
# RUN yarn install --frozen-lockfile

# Build the project
# RUN yarn build:provider

# Specify the command to run the application
# CMD ["yarn", "start:provider:prod"]
