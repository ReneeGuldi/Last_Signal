# Last Signal: game + multiplayer server in one container
# Build:  docker build -t last-signal .
# Run:    docker run -p 3000:3000 last-signal
# Then open http://localhost:3000

FROM node:20-alpine

WORKDIR /app

# Install the server's packages first, so Docker can reuse this step
# when only the game files change
COPY server/package*.json server/
RUN cd server && npm install --omit=dev

# Copy the rest of the game (index.html, main.js, net.js, models/, server/)
COPY . .

EXPOSE 3000
CMD ["node", "server/server.js"]