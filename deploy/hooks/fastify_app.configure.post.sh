#!/bin/bash
# Add ExecStartPre to run site-admin init before the server starts.
# site-admin init is idempotent: creates SITE_ROOT subdirs + runs migrations
# on first boot, no-ops on subsequent restarts.
set -euo pipefail
source "$DEPLOY_HOME/lib/common.sh"

: "${APP_NAME:?APP_NAME not set}"
: "${NODE_APP_SYSTEMD_PATH:=/etc/systemd/system}"
: "${NODE_APP_NODE_OPTIONS:=}"
: "${NODE_APP_MAIN_SCRIPT:=bin/server.js}"

init_cmd="/usr/bin/node ${NODE_APP_NODE_OPTIONS} bin/site-admin init"
service_file="${NODE_APP_SYSTEMD_PATH}/${APP_NAME}.service"

remote_exec "sudo sed -i 's|^ExecStart=|ExecStartPre=${init_cmd}\nExecStart=|' '${service_file}'"
remote_exec "sudo systemctl daemon-reload"

echo "  fastify_app.configure.post: added ExecStartPre for site-admin init"
