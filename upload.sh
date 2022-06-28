#/bin/bash

rsync -a --exclude node_modules . root@treepadcloudenterprise.com:/home/moduleQuillServer
