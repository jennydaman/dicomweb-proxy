FROM registry.access.redhat.com/ubi9/nodejs-18-minimal:1-74.1695740475

COPY --chown=1001:0 . .
RUN ["npm", "install"]
CMD ["npm", "start"]
EXPOSE 5000
HEALTHCHECK --interval=5m --timeout=3s --start-period=5s --start-interval=5s CMD curl -f http://localhost:5000/app-config.js || exit 1
