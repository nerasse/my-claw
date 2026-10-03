# A fresh machine for the bare-metal install test (docs/install-test.md): systemd as PID 1, sudo,
# curl, one unprivileged user. Nothing of my-claw: the installer has to bring everything else.
ARG BASE=debian:bookworm
FROM ${BASE}
ENV container=docker
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends systemd systemd-sysv dbus sudo curl ca-certificates iproute2 \
 && rm -rf /var/lib/apt/lists/* \
 && (id -u ubuntu >/dev/null 2>&1 && userdel -r ubuntu || true) \
 && useradd -m -s /bin/bash claw \
 && rm -f /lib/systemd/system/multi-user.target.wants/getty.target /etc/systemd/system/getty.target.wants/* \
 && systemctl mask systemd-firstboot.service systemd-udevd.service systemd-modules-load.service console-getty.service getty@tty1.service
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
