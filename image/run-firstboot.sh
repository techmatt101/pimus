#!/bin/sh
set -eu

export ANSIBLE_CONFIG=/opt/pimus/ansible.cfg
export ANSIBLE_LOCAL_TEMP=/var/tmp/pimus-ansible

/usr/bin/mkdir -p "$ANSIBLE_LOCAL_TEMP" /var/lib/pimus
cd /opt/pimus
/usr/bin/ansible-playbook \
    --inventory localhost, \
    /opt/pimus/playbooks/local.yml

/usr/bin/touch /var/lib/pimus/provisioned
/usr/bin/systemctl disable pimus-firstboot.service
