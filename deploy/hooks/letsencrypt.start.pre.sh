#!/bin/bash
# Ensure the ACME webroot exists before certbot tries to write a challenge file.
# The fastify_app module creates this directory during its install stage, but
# letsencrypt runs first within the start stage.
set -euo pipefail
source "$DEPLOY_HOME/lib/common.sh"

webroot="${LETSENCRYPT_WEBROOT:-/var/www/${APP_NAME}}"
remote_exec "sudo mkdir -p '${webroot}' && sudo chown www-data:www-data '${webroot}'"
echo "  letsencrypt.start.pre: ensured ${webroot} exists on server"
