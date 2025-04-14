# https://blog.3d-logic.com/2023/02/05/running-puppeteer-in-a-docker-container-on-raspberry-pi/
# Ensure an up-to-date version of Chromium 
# can be installed (solves Problem 2)
FROM node:20-bullseye 
# Install a working version of Chromium (solves Problem 1)
RUN apt-get update
RUN apt-get install chromium -y
ENV HOME=/home/app-user
RUN useradd -m -d $HOME -s /bin/bash app-user 
RUN mkdir -p $HOME/app
WORKDIR $HOME/app
COPY package*.json ./
COPY src/ ./src
RUN chown -R app-user:app-user $HOME
# Run the container as a non-privileged user (discussed in Problem 3)
USER app-user
# Make `npm install` faster by skipping 
# downloading default Chromium (discussed in Problem 1)
RUN npm install
# expose port 7700 
EXPOSE 7700
CMD [ "npm", "run", "start" ]